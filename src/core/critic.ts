import type { GateRow, ProfileId, Severity } from "../types.js";
import { canonicalJson, sha256 } from "./hashing.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface CriticPacket {
  schemaVersion: 1;
  packetHash: string;
  candidateHash: string;
  oracleHash: string;
  profile: ProfileId;
  style: string;
  deterministicPassed: boolean;
  rows: CriticRow[];
  captures: string[];
  visualFindings: CriticFinding[];
}

export type CriticRow = Pick<GateRow, "code" | "passed" | "severity" | "message">
  & Partial<Pick<GateRow, "component" | "score" | "view">>;

export interface CriticFinding {
  criterion: string;
  evidence: string;
  severity: Severity;
  affectedRegionView: string;
  expectedCorrection: string;
  reopenDeterministicGate: boolean;
}

export interface CriticVerdict {
  schemaVersion: 1;
  verdict: "PASS" | "FAIL";
  candidateHash: string;
  oracleHash: string;
  packetHash: string;
  independentProcess: boolean;
  findings: CriticFinding[];
}

export function createCriticPacket(input: Omit<CriticPacket, "schemaVersion" | "packetHash" | "visualFindings"> & { visualFindings?: CriticFinding[] }): CriticPacket {
  const payload = { schemaVersion: 1 as const, ...input, visualFindings: input.visualFindings ?? [] };
  return { ...payload, packetHash: sha256(canonicalJson(payload)) };
}

export function evaluateCriticPacket(packet: CriticPacket, independentProcess = false): CriticVerdict {
  const { packetHash, ...payload } = packet;
  if (sha256(canonicalJson(payload)) !== packetHash) throw new Error("critic packet hash is invalid");
  const findings = packet.rows.filter((row) => !row.passed).map((row): CriticFinding => ({
    criterion: row.code,
    evidence: row.message,
    severity: row.severity,
    affectedRegionView: [row.component ?? "whole candidate", row.view].filter(Boolean).join(" / "),
    expectedCorrection: row.message,
    reopenDeterministicGate: true,
  }));
  findings.push(...packet.visualFindings);
  if (!packet.deterministicPassed && !findings.length) {
    findings.push({
      criterion: "deterministic-gate",
      evidence: "deterministic gate did not pass",
      severity: "critical",
      affectedRegionView: "whole candidate",
      expectedCorrection: "return to build and clear deterministic failures",
      reopenDeterministicGate: true,
    });
  }
  return {
    schemaVersion: 1,
    verdict: packet.deterministicPassed && findings.length === 0 ? "PASS" : "FAIL",
    candidateHash: packet.candidateHash,
    oracleHash: packet.oracleHash,
    packetHash,
    independentProcess,
    findings,
  };
}

export function assertCriticVerdictFresh(verdict: CriticVerdict, candidateHash: string): void {
  if (verdict.candidateHash !== candidateHash) throw new Error(`critic verdict is stale for candidate ${candidateHash}`);
  if (!verdict.independentProcess) throw new Error("critic verdict was not produced by an independent process");
}

export async function runIndependentCritic(packet: CriticPacket, workerPath = fileURLToPath(new URL("../critic-worker.js", import.meta.url))): Promise<CriticVerdict> {
  return await new Promise<CriticVerdict>((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`independent critic exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as CriticVerdict);
      } catch (error) {
        reject(new Error(`independent critic returned invalid JSON: ${String(error)}`));
      }
    });
    child.stdin.end(JSON.stringify(packet));
  });
}

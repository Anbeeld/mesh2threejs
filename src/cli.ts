#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditCandidateSource, loadCandidateModule } from "./core/candidate.js";
import { runIndependentCritic, type CriticPacket } from "./core/critic.js";
import { evaluateCandidate } from "./core/orchestration.js";
import { loadPreparedOracle, onboardOracle, probeGlb, repairPreparedOracle, verifyOracleRegistration, type OnboardOracleInput, type OracleManifest, type RegistrationExpectation, type RepairPreparedOracleInput } from "./core/oracle.js";
import { routeSubject } from "./core/routing.js";
import { certifyState, loadTaskState, saveTaskState } from "./core/state.js";
import { initializeWorkspace } from "./core/workspace.js";
import type { ProfileId } from "./types.js";
import { validateOracleManifest } from "./core/schema.js";

interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

function parseOptions(args: string[]): { positional: string[]; options: Record<string, string> } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals >= 0) {
      options[value.slice(2, equals)] = value.slice(equals + 1);
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`option ${value} requires a value`);
    options[value.slice(2)] = next;
    index += 1;
  }
  return { positional, options };
}

function required(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const HELP = `mesh2threejs commands:
  init --workspace DIR --id ID --goal TEXT --profile tank|generic --oracle PATH --candidate PATH
  route TEXT
  probe GLB
  onboard --config INPUT.json --out manifest.json
  repair-oracle --manifest manifest.json --config repair.json --out repaired-manifest.json
  register --manifest manifest.json --config expectation.json [--out evidence.json]
  audit-candidate MODULE
  gate --oracle manifest.json --candidate MODULE --profile tank|generic [--out report.json]
  critic PACKET.json [--out verdict.json]
  finalize STATE.json
`;

export async function runCli(argv: string[], io: CliIo = { stdout: console.log, stderr: console.error }): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      io.stdout(HELP);
      return 0;
    }
    const parsed = parseOptions(args);
    switch (command) {
      case "init": {
        const profile = required(parsed.options, "profile");
        if (profile !== "tank" && profile !== "generic") throw new Error("--profile must be tank or generic");
        const result = await initializeWorkspace(required(parsed.options, "workspace"), {
          id: required(parsed.options, "id"),
          goal: required(parsed.options, "goal"),
          profile,
          style: parsed.options.style ?? "low-poly-faithful",
          oracleManifest: required(parsed.options, "oracle"),
          candidateModule: required(parsed.options, "candidate"),
          certification: parsed.options.certification === "exact-real" ? "exact-real" : "oracle-relative",
        });
        io.stdout(json({ status: "initialized", taskId: required(parsed.options, "id"), ...result }));
        return 0;
      }
      case "route": {
        const prompt = parsed.positional.join(" ");
        if (!prompt) throw new Error("route requires task text");
        io.stdout(json({ profile: routeSubject(prompt) }));
        return 0;
      }
      case "probe": {
        const path = parsed.positional[0];
        if (!path) throw new Error("probe requires a GLB path");
        io.stdout(json(probeGlb(await readFile(resolve(path)))));
        return 0;
      }
      case "onboard": {
        const configPath = required(parsed.options, "config");
        const outputPath = resolve(required(parsed.options, "out"));
        const config = JSON.parse(await readFile(resolve(configPath), "utf8")) as OnboardOracleInput;
        const manifest = await onboardOracle(config);
        await writeFile(outputPath, `${json(manifest)}\n`, { flag: "wx" });
        io.stdout(json({ status: "onboarded", manifest: outputPath, sourceHash: manifest.sourceHash, preparedHash: manifest.preparedHash }));
        return 0;
      }
      case "repair-oracle": {
        const manifest = JSON.parse(await readFile(resolve(required(parsed.options, "manifest")), "utf8")) as OracleManifest;
        if (!validateOracleManifest(manifest).valid) throw new Error("oracle manifest schema is invalid");
        const config = JSON.parse(await readFile(resolve(required(parsed.options, "config")), "utf8")) as RepairPreparedOracleInput;
        const repaired = await repairPreparedOracle(manifest, config);
        const outputPath = resolve(required(parsed.options, "out"));
        await writeFile(outputPath, `${json(repaired)}\n`, { flag: "wx" });
        io.stdout(json({ status: "repaired", manifest: outputPath, sourceHash: repaired.sourceHash, preparedHash: repaired.preparedHash }));
        return 0;
      }
      case "register": {
        const manifest = JSON.parse(await readFile(resolve(required(parsed.options, "manifest")), "utf8")) as OracleManifest;
        if (!validateOracleManifest(manifest).valid) throw new Error("oracle manifest schema is invalid");
        const expectation = JSON.parse(await readFile(resolve(required(parsed.options, "config")), "utf8")) as RegistrationExpectation;
        const evidence = verifyOracleRegistration(await loadPreparedOracle(manifest), expectation);
        const rendered = `${json(evidence)}\n`;
        if (parsed.options.out) await writeFile(resolve(parsed.options.out), rendered);
        io.stdout(rendered.trimEnd());
        return evidence.passed ? 0 : 4;
      }
      case "audit-candidate": {
        const path = parsed.positional[0];
        if (!path) throw new Error("audit-candidate requires a module path");
        const result = auditCandidateSource(await readFile(resolve(path), "utf8"));
        io.stdout(json(result));
        return result.passed ? 0 : 3;
      }
      case "gate": {
        const manifest = JSON.parse(await readFile(resolve(required(parsed.options, "oracle")), "utf8")) as OracleManifest;
        if (!validateOracleManifest(manifest).valid) throw new Error("oracle manifest schema is invalid");
        const candidate = await loadCandidateModule(resolve(required(parsed.options, "candidate")));
        const oracle = await loadPreparedOracle(manifest);
        const profile = required(parsed.options, "profile") as ProfileId;
        if (profile !== "tank" && profile !== "generic") throw new Error("--profile must be tank or generic");
        const evaluation = evaluateCandidate({
          oracle,
          candidate,
          profile,
          certification: manifest.authoritativeDimensions ? "exact-real" : "oracle-relative",
          ...(manifest.authoritativeDimensions && "hullLength" in manifest.authoritativeDimensions
            ? { authoritativeDimensions: manifest.authoritativeDimensions as { hullLength: number; overallLength: number; width: number; height: number } }
            : {}),
        });
        const rendered = `${json(evaluation)}\n`;
        if (parsed.options.out) await writeFile(resolve(parsed.options.out), rendered);
        io.stdout(rendered.trimEnd());
        return evaluation.passed ? 0 : 4;
      }
      case "critic": {
        const path = parsed.positional[0];
        if (!path) throw new Error("critic requires a packet path");
        const packet = JSON.parse(await readFile(resolve(path), "utf8")) as CriticPacket;
        const verdict = await runIndependentCritic(packet);
        const rendered = `${json(verdict)}\n`;
        if (parsed.options.out) await writeFile(resolve(parsed.options.out), rendered);
        io.stdout(rendered.trimEnd());
        return verdict.verdict === "PASS" ? 0 : 5;
      }
      case "finalize": {
        const statePath = parsed.positional[0];
        if (!statePath) throw new Error("finalize requires a state path");
        const certified = certifyState(await loadTaskState(resolve(statePath)));
        await saveTaskState(resolve(statePath), certified);
        io.stdout(json({ status: certified.status, candidateHash: certified.candidateHash }));
        return 0;
      }
      default:
        io.stderr(`unknown command: ${command}\n${HELP}`);
        return 2;
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}

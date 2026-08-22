import type { GateRow } from "../types.js";
import { canonicalJson, sha256 } from "./hashing.js";

export interface DeterministicReplayPacket {
  schemaVersion: 1;
  oracleHash: string;
  candidateHash: string;
  rows: Array<Pick<GateRow, "code" | "passed" | "severity" | "message">>;
  packetHash: string;
}

export function createDeterministicReplayPacket(input: Omit<DeterministicReplayPacket, "schemaVersion" | "packetHash">): DeterministicReplayPacket {
  const payload = { schemaVersion: 1 as const, ...input };
  return { ...payload, packetHash: sha256(canonicalJson(payload)) };
}

export function replayDeterministicRows(packet: DeterministicReplayPacket): { kind: "deterministic-replay"; passed: boolean; packetHash: string; failedCodes: string[] } {
  const { packetHash, ...payload } = packet;
  if (sha256(canonicalJson(payload)) !== packetHash) throw new Error("deterministic replay packet hash is invalid");
  const failedCodes = packet.rows.filter((row) => !row.passed).map((row) => row.code);
  return { kind: "deterministic-replay", passed: failedCodes.length === 0, packetHash, failedCodes };
}

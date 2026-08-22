import { canonicalJson, sha256 } from "./hashing.js";
import type { ProfileId, Severity } from "../types.js";

export interface CaptureReference {
  path: string;
  sha256: string;
  pass: string;
  cameraId: string;
}

export interface VisualReviewPacket {
  schemaVersion: 2;
  oracleHash: string;
  candidateHash: string;
  profile: ProfileId;
  profileContractHash: string;
  styleHash: string;
  deterministicArtifactHash: string;
  captures: CaptureReference[];
  comparisonBoardHashes: string[];
  turntableHashes: string[];
  articulationArtifactHash: string;
  regionEvidence: { status: "available"; semanticArtifactHash: string } | { status: "unavailable"; reason: string };
  packetHash: string;
}

export interface VisualFinding {
  criterion: string;
  evidence: string;
  severity: Severity;
  regionView: string;
  expectedCorrection: string;
  reopenPhase: string;
}

export interface VisualReviewVerdict {
  schemaVersion: 2;
  packetHash: string;
  reviewer: { kind: "external-vision"; id: string };
  verdict: "PASS" | "FAIL";
  findings: VisualFinding[];
  reviewedAt: string;
  verdictHash: string;
}

export function createVisualReviewPacket(input: Omit<VisualReviewPacket, "schemaVersion" | "packetHash">): VisualReviewPacket {
  if (!input.captures.length || !input.turntableHashes.length || !input.comparisonBoardHashes.length) throw new Error("visual review requires immutable captures, comparison boards, and turntable evidence");
  if (input.captures.some((capture) => !/^[a-f0-9]{64}$/u.test(capture.sha256))) throw new Error("visual capture reference lacks a content hash");
  if (input.regionEvidence.status === "available" && !/^[a-f0-9]{64}$/u.test(input.regionEvidence.semanticArtifactHash)) throw new Error("available region evidence requires a valid semantic artifact hash");
  if (input.regionEvidence.status === "unavailable" && !input.regionEvidence.reason.trim()) throw new Error("unavailable region evidence requires a reason");
  const payload = { schemaVersion: 2 as const, ...input };
  return { ...payload, packetHash: sha256(canonicalJson(payload)) };
}

export function verifyVisualReviewPacket(packet: VisualReviewPacket): void {
  const { packetHash, ...payload } = packet;
  if (sha256(canonicalJson(payload)) !== packetHash) throw new Error("visual review packet hash is invalid");
}

export function createVisualReviewVerdict(input: Omit<VisualReviewVerdict, "schemaVersion" | "reviewedAt" | "verdictHash">): VisualReviewVerdict {
  if (input.reviewer.kind !== "external-vision" || !input.reviewer.id.trim()) throw new Error("a genuine external vision reviewer identity is required");
  if ((input.verdict === "PASS") !== (input.findings.length === 0)) throw new Error("visual verdict contradicts its findings");
  const payload = { schemaVersion: 2 as const, ...input, reviewedAt: new Date().toISOString() };
  return { ...payload, verdictHash: sha256(canonicalJson(payload)) };
}

export function verifyVisualReviewVerdict(packet: VisualReviewPacket, verdict: VisualReviewVerdict): void {
  verifyVisualReviewPacket(packet);
  const { verdictHash, ...payload } = verdict;
  if (sha256(canonicalJson(payload)) !== verdictHash) throw new Error("visual review verdict hash is invalid");
  if (verdict.packetHash !== packet.packetHash) throw new Error("visual review verdict is stale");
  if (verdict.reviewer.kind !== "external-vision") throw new Error("deterministic replay is not visual review");
}

export function awaitingVisualReview(packet: VisualReviewPacket): { status: "awaiting-visual-review"; packetHash: string } {
  verifyVisualReviewPacket(packet);
  return { status: "awaiting-visual-review", packetHash: packet.packetHash };
}

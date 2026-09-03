import { canonicalJson, sha256 } from "./hashing.js";
import type { ProfileId, Severity } from "../types.js";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface CaptureReference {
  path: string;
  sha256: string;
  pass: string;
  cameraId: string;
}

export interface ReviewFileReference {
  path: string;
  sha256: string;
  role: "capture" | "comparison-board" | "turntable" | "deterministic" | "style" | "articulation" | "region" | "style-reference";
}

/**
 * Style authority files presented to the reviewer (schema v5, stylized-authored mode): the
 * registered art-direction images and the written brief the human must view while judging
 * style identity. Each entry is byte-verified like every other referenced file.
 */
export interface StyleReferenceBinding {
  path: string;
  sha256: string;
  label: string;
}

export interface VisualReviewPacket {
  schemaVersion: 5;
  /** Stylized-authored only: the frozen construction this packet reviews. */
  constructionFreezeId?: string;
  /** Stylized-authored only: the style binding the reviewed candidate was frozen against. */
  styleBindingHash?: string;
  /** Stylized-authored only: the exact art-direction files bound into this packet. */
  styleReferences?: StyleReferenceBinding[];
  oracleHash: string;
  candidateHash: string;
  profile: ProfileId;
  profileContractHash: string;
  styleContractHash: string;
  evaluationIdentityHash: string;
  styleHash: string;
  deterministicArtifactHash: string;
  captures: CaptureReference[];
  comparisonBoardHashes: string[];
  turntableHashes: string[];
  articulationArtifactHash?: string;
  regionEvidence: { status: "available"; semanticArtifactHash: string } | { status: "unavailable"; reason: string };
  files: ReviewFileReference[];
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

function assertVisualReviewPacketContents(input: Omit<VisualReviewPacket, "packetHash"> | Omit<VisualReviewPacket, "schemaVersion" | "packetHash">): void {
  if (!input.captures.length || !input.turntableHashes.length || !input.comparisonBoardHashes.length) throw new Error("visual review requires immutable captures, comparison boards, and turntable evidence");
  if (input.captures.some((capture) => !/^[a-f0-9]{64}$/u.test(capture.sha256))) throw new Error("visual capture reference lacks a content hash");
  if (input.regionEvidence.status === "available" && !/^[a-f0-9]{64}$/u.test(input.regionEvidence.semanticArtifactHash)) throw new Error("available region evidence requires a valid semantic artifact hash");
  if (input.regionEvidence.status === "unavailable" && !input.regionEvidence.reason.trim()) throw new Error("unavailable region evidence requires a reason");
  if (!input.files.length || input.files.some((file) => !file.path.trim() || !/^[a-f0-9]{64}$/u.test(file.sha256))) throw new Error("visual review requires valid referenced files");
  for (const capture of input.captures) if (!input.files.some((file) => file.role === "capture" && file.path === capture.path && file.sha256 === capture.sha256)) throw new Error(`visual capture is absent from referenced files: ${capture.path}`);
  for (const hash of input.comparisonBoardHashes) if (!input.files.some((file) => file.role === "comparison-board" && file.sha256 === hash)) throw new Error("comparison board hash has no referenced file");
  for (const hash of input.turntableHashes) if (!input.files.some((file) => file.role === "turntable" && file.sha256 === hash)) throw new Error("turntable hash has no referenced file");
  if (!input.files.some((file) => file.role === "deterministic" && file.sha256 === input.deterministicArtifactHash)) throw new Error("deterministic artifact hash has no referenced file");
  if (!input.files.some((file) => file.role === "style" && file.sha256 === input.styleHash)) throw new Error("style artifact hash has no referenced file");
  if (input.articulationArtifactHash && !input.files.some((file) => file.role === "articulation" && file.sha256 === input.articulationArtifactHash)) throw new Error("articulation artifact hash has no referenced file");
  const regionArtifactHash = input.regionEvidence.status === "available" ? input.regionEvidence.semanticArtifactHash : undefined;
  if (regionArtifactHash && !input.files.some((file) => file.role === "region" && file.sha256 === regionArtifactHash)) throw new Error("region artifact hash has no referenced file");
}

export function createVisualReviewPacket(input: Omit<VisualReviewPacket, "schemaVersion" | "packetHash">): VisualReviewPacket {
  assertVisualReviewPacketContents(input);
  const payload = { schemaVersion: 5 as const, ...input };
  return { ...payload, packetHash: sha256(canonicalJson(payload)) };
}

export async function verifyVisualReviewPacketFiles(packet: VisualReviewPacket, root?: string): Promise<void> {
  verifyVisualReviewPacket(packet);
  for (const reference of packet.files) {
    const path = root && !isAbsolute(reference.path) ? resolve(root, reference.path) : resolve(reference.path);
    if (root) {
      const relation = relative(resolve(root), path);
      if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relation)) throw new Error(`visual review referenced file escapes its workspace: ${reference.path}`);
    }
    const bytes = await readFile(path);
    if (sha256(bytes) !== reference.sha256) throw new Error(`visual review referenced file changed or is incorrect: ${reference.path}`);
    if (["capture", "comparison-board", "turntable"].includes(reference.role) && (bytes.length < 8 || bytes.subarray(1, 4).toString() !== "PNG")) throw new Error(`visual review image is not a PNG: ${reference.path}`);
  }
}

export function verifyVisualReviewPacket(packet: VisualReviewPacket): void {
  if (packet.schemaVersion !== 5 || !packet.styleContractHash || !packet.evaluationIdentityHash) throw new Error("visual review packet schema or evaluation identity is invalid");
  // Stylized art authority: a packet bound to a construction freeze must carry the exact
  // style-reference files in its referenced set (design §23).
  if (packet.constructionFreezeId) {
    if (!packet.styleBindingHash) throw new Error("a stylized review packet bound to a construction freeze must carry the style binding hash");
    if (!packet.styleReferences?.length) throw new Error("a stylized review packet bound to a construction freeze must reference the registered style files");
    for (const reference of packet.styleReferences) {
      const bound = packet.files.find((file) => file.role === "style-reference" && file.path === reference.path && file.sha256 === reference.sha256);
      if (!bound) throw new Error(`style reference is absent from the referenced files: ${reference.path}`);
      if (reference.label !== "brief" && !/\.(png|jpg|jpeg|webp|avif|bmp)$/iu.test(reference.path)) {
        throw new Error(`style reference image has an unsupported extension: ${reference.path}`);
      }
    }
  }
  const { packetHash, ...payload } = packet;
  if (sha256(canonicalJson(payload)) !== packetHash) throw new Error("visual review packet hash is invalid");
  assertVisualReviewPacketContents(packet);
}

export function createVisualReviewVerdict(input: Omit<VisualReviewVerdict, "schemaVersion" | "reviewedAt" | "verdictHash">): VisualReviewVerdict {
  if (input.reviewer.kind !== "external-vision" || !input.reviewer.id.trim()) throw new Error("a genuine external vision reviewer identity is required");
  if ((input.verdict === "PASS") !== (input.findings.length === 0)) throw new Error("visual verdict contradicts its findings");
  const payload = { schemaVersion: 2 as const, ...input, reviewedAt: new Date().toISOString() };
  return { ...payload, verdictHash: sha256(canonicalJson(payload)) };
}

export function verifyVisualReviewVerdict(packet: VisualReviewPacket, verdict: VisualReviewVerdict): void {
  verifyVisualReviewPacket(packet);
  if (verdict.schemaVersion !== 2) throw new Error("visual review verdict schema is invalid");
  const { verdictHash, ...payload } = verdict;
  if (sha256(canonicalJson(payload)) !== verdictHash) throw new Error("visual review verdict hash is invalid");
  if (verdict.packetHash !== packet.packetHash) throw new Error("visual review verdict is stale");
  if (verdict.reviewer.kind !== "external-vision" || !verdict.reviewer.id.trim()) throw new Error("a genuine external vision reviewer identity is required");
  if ((verdict.verdict === "PASS") !== (verdict.findings.length === 0)) throw new Error("visual verdict contradicts its findings");
  if (verdict.findings.some((finding) => !finding.criterion.trim() || !finding.evidence.trim() || !finding.regionView.trim() || !finding.expectedCorrection.trim() || !finding.reopenPhase.trim() || !["critical", "major", "minor"].includes(finding.severity))) throw new Error("visual review verdict contains an invalid finding");
}

export function awaitingVisualReview(packet: VisualReviewPacket): { status: "awaiting-visual-review"; packetHash: string } {
  verifyVisualReviewPacket(packet);
  return { status: "awaiting-visual-review", packetHash: packet.packetHash };
}

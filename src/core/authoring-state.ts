import { canonicalJson, sha256 } from "./hashing.js";
import { ConstructionRoutingError } from "./construction-mode.js";
import type { TaskState } from "./state.js";
import type { StyleBinding } from "./style-binding.js";
import type { AuthoredBinding } from "./authored-candidate.js";
import type { ConstructionRoutingCode } from "./construction-mode.js";

/**
 * Stylized authoring lifecycle (stylized-authored mode design §7/§19/§25). Mutable whole-object
 * authoring with ONE strong authority boundary (construction freeze), replacing the derived
 * pipeline's per-phase immutable locks for this mode. Early art milestones are CHECKPOINTS
 * (evidence, not authority); authority applies at freeze. Reopening authoring invalidates
 * freeze identity, deterministic validation evidence, the review packet, and any human
 * approval — it never invalidates the oracle or style binding unless those inputs changed.
 */

export type AuthoringCheckpointKind = "blockout" | "primary-forms" | "secondary-forms" | "final-draft";

export const AUTHORING_CHECKPOINT_KINDS: ReadonlySet<AuthoringCheckpointKind> = new Set(["blockout", "primary-forms", "secondary-forms", "final-draft"]);

export type AuthoringStatus = "authoring" | "frozen" | "validated" | "visual-review" | "approved" | "final";

export interface AuthoringCheckpoint {
  id: string;
  kind: AuthoringCheckpointKind;
  candidateHash: string;
  capturesHash: string;
  assessmentHash?: string;
  createdAt: string;
}

export interface AuthoringFreezeRecord {
  id: string;
  candidateHash: string;
  authorSpecHash: string;
  compiledGraphHash: string;
  styleBinding: string;
  oracleBinding: string;
  featurePlanHash: string | null;
  compilerVersion: string;
  /** Content binding of the final-draft visual evidence (design §19): the freeze does not
   * merely PRECONDITION on a final-draft checkpoint, it binds the checkpoint's candidate
   * hash, capture-set hash, and assessment hash so "visual evidence before freeze" is a
   * verifiable content fact inside the freeze identity itself. */
  finalDraftCheckpointId: string;
  finalDraftCapturesHash: string;
  finalDraftAssessmentHash: string | null;
  createdAt: string;
}

export interface AuthoringValidationRecord {
  freezeId: string;
  reportHash: string;
  passed: boolean;
  recordedAt: string;
}

export interface AuthoringReviewRecord {
  freezeId: string;
  packetHash: string;
  status: "awaiting" | "approved" | "rejected";
  decidedAt: string;
}

export interface StylizedAuthoringState {
  mode: "stylized-authored";
  oracleBinding: string | null;
  styleBinding: StyleBinding | null;
  status: AuthoringStatus;
  checkpoints: AuthoringCheckpoint[];
  freeze?: AuthoringFreezeRecord;
  validation?: AuthoringValidationRecord;
  review?: AuthoringReviewRecord;
  /** Structured builder assessments are diagnostic data, never human approval (design §18.2). */
  assessments: Array<{ checkpointId: string; assessment: Record<string, unknown>; recordedAt: string }>;
}

export function createAuthoringState(): StylizedAuthoringState {
  return { mode: "stylized-authored", oracleBinding: null, styleBinding: null, status: "authoring", checkpoints: [], assessments: [] };
}

function fail(code: ConstructionRoutingCode, message: string): never {
  throw new ConstructionRoutingError(code, message);
}

export function assertAuthoringEditable(state: TaskState): void {
  const authoring = state.authoring;
  if (!authoring) return;
  if (authoring.status !== "authoring") {
    fail("AUTHORING_FROZEN", `authoring is ${authoring.status}; construction is frozen. Use reopen-authoring(reason) to edit, which invalidates all post-freeze evidence`);
  }
}

export function assertStyleBindingBound(state: TaskState): StyleBinding {
  const binding = state.authoring?.styleBinding;
  if (!binding) fail("STYLE_BINDING_REQUIRED", "no style binding is recorded for this stylized run; register style/references.json (+ style/brief.md) and rerun author-compile");
  return binding;
}

function requireAuthoring(state: TaskState): StylizedAuthoringState {
  if (!state.authoring) fail("MODE_REQUIRES_AUTHORED_SPEC", "this run has no stylized authoring state; the construction mode must be stylized-authored");
  return state.authoring;
}

/** Records a non-authoritative authoring checkpoint (design §7.2/§18). Later edits supersede it. */
export function recordAuthorCheckpoint(state: TaskState, input: {
  kind: AuthoringCheckpointKind;
  candidateHash: string;
  capturesHash: string;
  assessment?: Record<string, unknown>;
}): TaskState {
  const authoring = requireAuthoring(state);
  if (authoring.status !== "authoring") fail("AUTHORING_FROZEN", "checkpoints are recorded during mutable authoring only");
  if (!AUTHORING_CHECKPOINT_KINDS.has(input.kind)) fail("AUTHOR_SPEC_INVALID", `unknown checkpoint kind: ${input.kind}`);
  if (!/^[a-f0-9]{64}$/u.test(input.candidateHash) || !/^[a-f0-9]{64}$/u.test(input.capturesHash)) {
    fail("AUTHOR_SPEC_INVALID", "checkpoint candidate/captures hashes must be sha256");
  }
  const next = structuredClone(state);
  const authoringNext = next.authoring!;
  const id = `${input.kind}-${authoringNext.checkpoints.length + 1}`;
  authoringNext.checkpoints.push({
    id,
    kind: input.kind,
    candidateHash: input.candidateHash,
    capturesHash: input.capturesHash,
    ...(input.assessment ? { assessmentHash: sha256(canonicalJson(input.assessment)) } : {}),
    createdAt: new Date().toISOString(),
  });
  if (input.assessment) {
    authoringNext.assessments.push({ checkpointId: id, assessment: structuredClone(input.assessment), recordedAt: new Date().toISOString() });
  }
  return next;
}

/**
 * Construction freeze (design §19): the FIRST strong authority boundary after setup. Requires
 * a bound style input and a final-draft checkpoint whose candidate hash matches the frozen
 * candidate (design Q5: final-draft visual evidence before freeze is mandatory).
 */
export function freezeAuthoring(state: TaskState, freeze: Omit<AuthoringFreezeRecord, "id" | "createdAt">): TaskState {
  const authoring = requireAuthoring(state);
  if (authoring.status !== "authoring") fail("AUTHORING_FROZEN", `cannot freeze from status ${authoring.status}`);
  if (!authoring.styleBinding) fail("STYLE_BINDING_REQUIRED", "missing style binding prevents stylized freeze; register style references first");
  if (!authoring.oracleBinding) fail("FREEZE_STALE", "no oracle preparation is bound to the authoring state; onboard the oracle first");
  const finalDraft = [...authoring.checkpoints].reverse().find((checkpoint) => checkpoint.kind === "final-draft");
  if (!finalDraft) fail("VISUAL_CHECKPOINT_REQUIRED", "construction freeze requires a final-draft visual checkpoint before it can bind evidence");
  if (finalDraft.candidateHash !== freeze.candidateHash) {
    fail("VISUAL_CHECKPOINT_REQUIRED", `final-draft checkpoint evidence is bound to candidate ${finalDraft.candidateHash.slice(0, 12)}…, not the frozen candidate ${freeze.candidateHash.slice(0, 12)}…; capture a fresh final-draft checkpoint`);
  }
  const next = structuredClone(state);
  const record: AuthoringFreezeRecord = {
    ...structuredClone(freeze),
    // The freeze BINDS the final-draft evidence content, not just its existence.
    finalDraftCheckpointId: finalDraft.id,
    finalDraftCapturesHash: finalDraft.capturesHash,
    finalDraftAssessmentHash: finalDraft.assessmentHash ?? null,
    id: "",
    createdAt: new Date().toISOString(),
  };
  record.id = authoringFreezeIdentity(record);
  next.authoring!.freeze = record;
  next.authoring!.status = "frozen";
  return next;
}

/**
 * Freeze identity: a CONTENT hash over everything freeze binds (design §19). The record
 * timestamp is deliberately excluded — two freezes of identical bound content are the same
 * freeze identity, so identity changes only when a bound input actually changes.
 */
export function authoringFreezeIdentity(freeze: Omit<AuthoringFreezeRecord, "id" | "createdAt">): string {
  const { createdAt: _createdAt, ...content } = freeze as AuthoringFreezeRecord;
  void _createdAt;
  return sha256(canonicalJson({ kind: "stylized-authored-freeze", ...structuredClone(content) }));
}

/**
 * Reopen (design §7.1): from frozen/validated/visual-review back to mutable authoring.
 * Invalidates freeze identity, validation evidence, review packet, and human approval.
 * Preserves oracle binding and style binding (those inputs did not change).
 */
export function reopenAuthoring(state: TaskState, reason: string): TaskState {
  const authoring = requireAuthoring(state);
  if (!reason.trim()) fail("AUTHOR_SPEC_INVALID", "reopen-authoring requires a reason");
  if (authoring.status !== "frozen" && authoring.status !== "validated" && authoring.status !== "visual-review") {
    fail("AUTHOR_SPEC_INVALID", `cannot reopen authoring from status ${authoring.status}`);
  }
  const next = structuredClone(state);
  const authoringNext = next.authoring!;
  authoringNext.status = "authoring";
  delete authoringNext.freeze;
  delete authoringNext.validation;
  delete authoringNext.review;
  authoringNext.checkpoints = authoringNext.checkpoints.filter((checkpoint) => checkpoint.kind !== "final-draft" || checkpoint.candidateHash !== authoring.freeze?.candidateHash);
  next.systemDecisions.push({ id: `reopen-authoring-${next.systemDecisions.length + 1}`, value: reason.trim(), reason: "authoring reopened; freeze identity, deterministic validation, review packet, and human approval were invalidated" });
  return next;
}

/** Records a deterministic validation outcome for the CURRENT freeze (design §20). */
export function recordAuthoringValidation(state: TaskState, input: { freezeId: string; reportHash: string; passed: boolean }): TaskState {
  const authoring = requireAuthoring(state);
  if (authoring.status !== "frozen" && authoring.status !== "validated") fail("FREEZE_STALE", "validation applies to a frozen construction only");
  if (!authoring.freeze || authoring.freeze.id !== input.freezeId) fail("FREEZE_STALE", `validation freeze id does not match the current freeze; construction changed since freeze`);
  if (!/^[a-f0-9]{64}$/u.test(input.reportHash)) fail("AUTHOR_SPEC_INVALID", "validation reportHash must be sha256");
  const next = structuredClone(state);
  const authoringNext = next.authoring!;
  authoringNext.validation = { freezeId: input.freezeId, reportHash: input.reportHash, passed: input.passed, recordedAt: new Date().toISOString() };
  if (input.passed) authoringNext.status = "validated";
  return next;
}

/**
 * Moves a validated freeze to visual review with its packet binding (design §23). Review
 * REGENERATION is a normal operation and never requires reopening geometry: a refreshed
 * packet is allowed from `visual-review` (new captures) and from `approved` (a refreshed
 * packet invalidates the prior approval — the canonical authority clears it when the new
 * packet binds). The freeze and its passing validation must be unchanged in every case.
 */
export function recordAuthoringReviewReady(state: TaskState, input: { freezeId: string; packetHash: string }): TaskState {
  const authoring = requireAuthoring(state);
  const refreshable = authoring.status === "validated" || authoring.status === "visual-review" || authoring.status === "approved";
  if (!refreshable) fail("FREEZE_STALE", `visual review requires a passing deterministic validation first (current status: ${authoring.status})`);
  if (!authoring.freeze || authoring.freeze.id !== input.freezeId) fail("FREEZE_STALE", "review packet freeze id does not match the current freeze");
  if (!authoring.validation?.passed || authoring.validation.freezeId !== input.freezeId) fail("FREEZE_STALE", "review regeneration requires the passing validation bound to the current freeze");
  if (!/^[a-f0-9]{64}$/u.test(input.packetHash)) fail("AUTHOR_SPEC_INVALID", "review packetHash must be sha256");
  const next = structuredClone(state);
  const authoringNext = next.authoring!;
  authoringNext.review = { freezeId: input.freezeId, packetHash: input.packetHash, status: "awaiting", decidedAt: new Date().toISOString() };
  authoringNext.status = "visual-review";
  return next;
}

/**
 * Human visual approval (design §24): the human approval channel remains separate from
 * builder authority. This pure function is invoked only from a human-admin capability path;
 * the approval binds the exact freeze/packet and is invalidated by any reopen.
 */
export function recordAuthoringReviewDecision(state: TaskState, input: { freezeId: string; packetHash: string; decision: "approved" | "rejected" }): TaskState {
  const authoring = requireAuthoring(state);
  if (authoring.status !== "visual-review") fail("FREEZE_STALE", "a review decision applies to a visual-review state only");
  if (!authoring.review || authoring.review.freezeId !== input.freezeId || authoring.review.packetHash !== input.packetHash) {
    fail("FREEZE_STALE", "review decision does not match the current review packet binding");
  }
  const next = structuredClone(state);
  const authoringNext = next.authoring!;
  authoringNext.review = { freezeId: input.freezeId, packetHash: input.packetHash, status: input.decision, decidedAt: new Date().toISOString() };
  authoringNext.status = input.decision === "approved" ? "approved" : "visual-review";
  return next;
}

/** Finalization: requires human-approved review bound to the current freeze (design §24). */
export function recordAuthoringFinal(state: TaskState, input: { freezeId: string }): TaskState {
  const authoring = requireAuthoring(state);
  if (authoring.status !== "approved") fail("FREEZE_STALE", "finalization requires a human-approved visual review");
  if (!authoring.freeze || authoring.freeze.id !== input.freezeId) fail("FREEZE_STALE", "finalization freeze id does not match the current freeze");
  const next = structuredClone(state);
  next.authoring!.status = "final";
  return next;
}

/** Authored bindings ledger distinct from derivedBindings (design §10/§25). */
export function bindAuthoredBindings(state: TaskState, bindings: Record<string, AuthoredBinding>): TaskState {
  const next = structuredClone(state);
  next.authoredBindings = structuredClone(bindings);
  return next;
}

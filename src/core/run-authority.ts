import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AuthorshipMode, CertificationLevel, ProfileId } from "../types.js";
import {
  acceptPhase,
  bindCandidatePhases,
  recordAttempt,
  reopenPhase,
  verifyEvidenceArtifact,
  type DerivedBinding,
  type EvidenceArtifact,
  type EvidenceRecord,
  type PhaseLock,
  type TaskState,
} from "./state.js";
import { canonicalJson, sha256 } from "./hashing.js";
import { projectPolicyHash, validatePolicyCreation, type PolicyDecision, type RunPolicy } from "./policy.js";
import type { ToolchainManifest } from "./toolchain.js";
import type { OraclePreparationBinding } from "./oracle.js";
import { assertCapability, type Capability } from "./capabilities.js";

/**
 * Canonical run authority. The authoritative record lives OUTSIDE builder-writable space;
 * the workspace `.mesh2threejs/state.json` is only a signed/hashed mirror of it. All
 * mutations flow through typed transitions applied inside the authority; builders never
 * hand authoritative hashes or pass flags to it.
 */

export interface RunAuthorityRecordState {
  /** Embedded pipeline bookkeeping; mutated only through validated transitions. */
  state: TaskState;
}

export interface HumanApproval {
  packetHash: string;
  candidateHash: string;
  oraclePreparationIdentity: string;
  toolchainId: string;
  trustedReplayHash: string;
  approvedAt: string;
  method: "broker-console" | "host-capability" | "test-capability";
}

export interface TrustedReplayRecord {
  /** Hash of the fresh whole-object evaluation bundle computed by the trusted runtime. */
  replayHash: string;
  passed: boolean;
  evaluationIdentityHash: string;
  candidateHash: string;
  oraclePreparationIdentity: string;
  evaluatedAt: string;
}

export interface RunAuthorityRecord {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  workspaceRoot: string;
  toolchain: Pick<ToolchainManifest, "runtimeHash" | "controlHash" | "dependencyIdentity" | "packageVersion"> & { toolchainId: string };
  harnessIdentity: string | null;
  policy: RunPolicy;
  policyDecisions: PolicyDecision[];
  projectPolicyHash: string;
  oraclePreparationIdentity: string | null;
  candidateHash: string | null;
  /**
   * Execution provenance of the sandbox that ran the candidate (closure plan §11.H1).
   * Recorded ONLY by trusted pipeline code from runtime facts; never a caller option.
   */
  candidateExecution: {
    authority: "trusted-derived-generated" | "trusted-host-sandbox" | "development-untrusted";
    backendId: string;
    backendIdentityHash: string;
  } | null;
  /** Full authority-owned review binding (closure plan §9.F2); hashes are authority, paths are provenance. */
  review: ReviewBinding;
  finalReplay: TrustedReplayRecord | null;
  viewerStartApproved: boolean;
  status: "active" | "awaiting-human-review" | "certified";
  mirrorSequence: number;
  embedded: RunAuthorityRecordState;
}

export interface ReviewCaptureReference {
  path: string;
  sha256: string;
  role: string;
}

export interface ReviewSceneBinding {
  path: string;
  sha256: string;
  sceneHash: string;
}

/** One authority-owned review artifact set: capture, scene, replay, candidate, policy, toolchain. */
export interface ReviewBinding {
  packetHash: string | null;
  replayHash: string | null;
  candidateHash: string | null;
  oraclePreparationIdentity: string | null;
  evaluationIdentityHash: string | null;
  toolchainId: string | null;
  scene: ReviewSceneBinding | null;
  captures: ReviewCaptureReference[];
  humanApproval: HumanApproval | null;
}

/**
 * Canonical run status derives from CURRENT facts only (closure plan §11.H2): a transition
 * may never merely assert `certified` before certification recomputation succeeds.
 */

export type BuilderAction =
  | { kind: "lock-phase"; phase: string }
  | { kind: "reopen-phase"; phase: string; reason: string }
  | { kind: "record-attempt"; action: string; evidenceHash: string; score: number }
  | { kind: "set-viewer-approved" };

export interface RunAuthorityStore {
  load(runId: string): Promise<RunAuthorityRecord>;
  save(record: RunAuthorityRecord): Promise<void>;
  find(): Promise<Array<Pick<RunAuthorityRecord, "runId" | "workspaceRoot" | "status">>>;
}

export class InMemoryRunAuthorityStore implements RunAuthorityStore {
  private readonly runs = new Map<string, RunAuthorityRecord>();
  async load(runId: string): Promise<RunAuthorityRecord> {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`unknown run: ${runId}`);
    return structuredClone(record);
  }
  async save(record: RunAuthorityRecord): Promise<void> {
    this.runs.set(record.runId, structuredClone(record));
  }
  async find() {
    return [...this.runs.values()].map(({ runId, workspaceRoot, status }) => ({ runId, workspaceRoot, status }));
  }
}

/** Broker-owned storage directory. Deployments must place this outside builder-writable authority. */
export class DirectoryRunAuthorityStore implements RunAuthorityStore {
  constructor(private readonly root: string) {}
  private path(runId: string): string {
    if (!/^[a-z0-9][a-z0-9-]{3,63}$/u.test(runId)) throw new Error(`invalid run id: ${runId}`);
    return join(resolve(this.root), `${runId}.json`);
  }
  async load(runId: string): Promise<RunAuthorityRecord> {
    const value = JSON.parse(await readFile(this.path(runId), "utf8")) as RunAuthorityRecord;
    if (value.schemaVersion !== 1 || value.runId !== runId) throw new Error(`authority record is invalid or mismatched: ${runId}`);
    return value;
  }
  async save(record: RunAuthorityRecord): Promise<void> {
    await mkdir(dirname(this.path(record.runId)), { recursive: true });
    const temporary = `${this.path(record.runId)}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, this.path(record.runId));
  }
  async find() {
    let names: string[] = [];
    try {
      names = (await readdirSafe(this.root)).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const out: Array<Pick<RunAuthorityRecord, "runId" | "workspaceRoot" | "status">> = [];
    for (const name of names) {
      try {
        const value = JSON.parse(await readFile(join(this.root, name), "utf8")) as RunAuthorityRecord;
        if (value.schemaVersion === 1 && typeof value.runId === "string") out.push({ runId: value.runId, workspaceRoot: value.workspaceRoot, status: value.status });
      } catch { /* skip unreadable records */ }
    }
    return out;
  }
}

async function readdirSafe(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try { return await readdir(root); } catch { return []; }
}

export interface TrustedRunCreation {
  runId: string;
  workspaceRoot: string;
  policy: RunPolicy;
  policyDecisions: PolicyDecision[];
  initialState: TaskState;
  toolchain: RunAuthorityRecord["toolchain"];
  harnessIdentity?: string | null;
  defaults: { hasOracle: boolean; routedProfile: ProfileId };
  requestedBy: Capability;
}

export interface RunTransitionContext {
  requestedBy: Capability;
}

const clone = <T>(value: T): T => structuredClone(value);

function recomputePolicyFields(record: RunAuthorityRecord): RunAuthorityRecord {
  record.projectPolicyHash = projectPolicyHash(record.policy, record.policyDecisions);
  return record;
}

export class TrustedRunAuthority {
  constructor(private readonly store: RunAuthorityStore) {}

  async createRun(input: TrustedRunCreation): Promise<RunAuthorityRecord> {
    // Run creation owns reconstruction policy: non-default policy requires an authority above
    // the builder, and even then every non-default field must carry its decision record. A
    // builder may start a run ONLY when every policy decision is the safe default computed by
    // trusted code (closure plan §4.A3) — weaker/non-default policy is administrative.
    if (input.requestedBy !== "builder") assertCapability("create-run", input.requestedBy);
    validatePolicyCreation(input.policy, input.policyDecisions, input.defaults);
    if (input.requestedBy === "builder" && input.policyDecisions.some((decision) => decision.source !== "safe-default" && decision.source !== "trusted-router")) {
      throw new Error("a builder may only begin runs under the safe-default policy; non-default policy requires human/admin approval");
    }
    const emptyReview: ReviewBinding = {
      packetHash: null,
      replayHash: null,
      candidateHash: null,
      oraclePreparationIdentity: null,
      evaluationIdentityHash: null,
      toolchainId: null,
      scene: null,
      captures: [],
      humanApproval: null,
    };
    const record = recomputePolicyFields({
      schemaVersion: 1,
      runId: input.runId,
      createdAt: new Date().toISOString(),
      workspaceRoot: resolve(input.workspaceRoot),
      toolchain: clone(input.toolchain),
      harnessIdentity: input.harnessIdentity ?? null,
      policy: clone(input.policy),
      policyDecisions: clone(input.policyDecisions),
      projectPolicyHash: "",
      oraclePreparationIdentity: input.initialState.oraclePreparation?.identity ?? null,
      candidateHash: input.initialState.candidateHash ?? null,
      candidateExecution: null,
      review: emptyReview,
      finalReplay: null,
      viewerStartApproved: false,
      status: "active",
      mirrorSequence: 1,
      embedded: { state: clone(input.initialState) },
    });
    await this.store.save(record);
    return record;
  }

  async readRun(runId: string): Promise<RunAuthorityRecord> {
    return this.store.load(runId);
  }

  /**
   * Applies a builder-safe SEMANTIC transition (closure plan §4.A1/A2): the builder may
   * request work, never submit authoritative outcomes. Every authoritative fact enters
   * through the recordComputed* methods below, which only trusted pipeline code calls.
   */
  async applyBuilderTransition(runId: string, action: BuilderAction, context: RunTransitionContext): Promise<RunAuthorityRecord> {
    if (context.requestedBy !== "builder" && context.requestedBy !== "human-admin") throw new Error(`unsupported capability for builder transitions: ${context.requestedBy}`);
    const record = await this.store.load(runId);
    if (record.status === "certified") throw new Error(`trusted run ${runId} is already certified; no further builder transitions apply`);
    const next = clone(record);
    const state = next.embedded.state;
    switch (action.kind) {
      case "lock-phase": {
        const phase = action.phase;
        const geometryHash = phase === "oracle-registration" ? state.oracleHash : state.phaseGeometryHashes[phase];
        if (!geometryHash) throw new Error(`no measured geometry is available for phase ${phase}`);
        const evidenceIds = Object.values(state.evidence)
          .filter((item) => item.phase === phase && item.valid && item.verified && item.passed)
          .map((item) => item.id);
        next.embedded.state = acceptPhase(state, phase, { geometryHash, evidenceIds, contractHash: state.profileContractHash });
        break;
      }
      case "reopen-phase": {
        // Reopen is builder-safe but bounded: it invalidates dependent facts and can never
        // change policy/contracts/thresholds.
        const updated = reopenPhase(state, action.phase, action.reason);
        next.embedded.state = updated;
        this.invalidateReviewAndReplay(next);
        break;
      }
      case "record-attempt": {
        next.embedded.state = recordAttempt(state, { action: action.action, evidenceHash: action.evidenceHash, score: action.score });
        break;
      }
      case "set-viewer-approved": {
        // Viewer start approval is human/administrative; the broker applies it after its own
        // channel confirms the operator. Builders cannot send this action.
        assertCapability("viewer-start", context.requestedBy);
        next.viewerStartApproved = true;
        break;
      }
      default: {
        const exhaustive: never = action;
        throw new Error(`unsupported builder action: ${JSON.stringify(exhaustive)}`);
      }
    }
    next.mirrorSequence += 1;
    await this.store.save(next);
    return next;
  }

  /**
   * Centralized review/replay invalidation (closure plan §11.H3): any mutation of the
   * candidate, oracle preparation, derived bindings, or evaluation identity invalidates the
   * human approval and the stored replay together.
   */
  private invalidateReviewAndReplay(next: RunAuthorityRecord): void {
    next.review.humanApproval = null;
    next.finalReplay = null;
    if (next.status === "awaiting-human-review") next.status = "active";
  }

  /** INTERNAL — trusted pipeline only. Records gate evidence computed by trusted evaluation code. */
  async recordComputedGate(runId: string, input: {
    phase: string | null;
    passed: boolean;
    evaluationIdentityHash: string;
    artifacts: EvidenceArtifact[];
    stateAfter: TaskState;
  }): Promise<RunAuthorityRecord> {
    return this.saveComputed(runId, input.stateAfter, (next) => {
      for (const artifact of input.artifacts) verifyEvidenceArtifact(artifact);
      void input.phase;
      void input.passed;
      void input.evaluationIdentityHash;
    });
  }

  /** INTERNAL — trusted pipeline only. Binds the candidate identity computed by trusted execution. */
  async recordComputedCandidate(runId: string, input: {
    candidateHash: string;
    phaseGeometryHashes: Record<string, string>;
    evaluationIdentity?: import("./identity.js").EvaluationIdentity;
    stateAfter?: TaskState;
  }): Promise<RunAuthorityRecord> {
    const record = await this.store.load(runId);
    const next = clone(record);
    let state = input.stateAfter ? clone(input.stateAfter) : next.embedded.state;
    state = bindCandidatePhases(state, input.candidateHash, input.phaseGeometryHashes, input.evaluationIdentity);
    const changed = next.candidateHash !== null && next.candidateHash !== input.candidateHash;
    next.candidateHash = input.candidateHash;
    next.review.candidateHash = input.candidateHash;
    next.embedded.state = state;
    if (changed || (next.review.humanApproval && next.review.humanApproval.candidateHash !== input.candidateHash)) this.invalidateReviewAndReplay(next);
    return this.persistComputed(next);
  }

  /** INTERNAL — trusted pipeline only. Records derived bindings produced by trusted derive code. */
  async recordComputedDerivedBindings(runId: string, input: {
    bindings: Record<string, DerivedBinding>;
    preparationIdentity: string;
    candidateHash?: string | null;
    phaseGeometryHashes?: Record<string, string>;
    stateAfter?: TaskState;
  }): Promise<RunAuthorityRecord> {
    const record = await this.store.load(runId);
    const next = clone(record);
    let state = input.stateAfter ? clone(input.stateAfter) : next.embedded.state;
    state.derivedBindings = clone(input.bindings);
    if (input.candidateHash !== undefined && input.candidateHash !== null) {
      const changed = next.candidateHash !== null && next.candidateHash !== input.candidateHash;
      state = bindCandidatePhases(state, input.candidateHash, input.phaseGeometryHashes ?? state.phaseGeometryHashes);
      next.candidateHash = input.candidateHash;
      next.review.candidateHash = input.candidateHash;
      if (changed) this.invalidateReviewAndReplay(next);
    }
    next.embedded.state = state;
    return this.persistComputed(next);
  }

  /** INTERNAL — trusted pipeline only. Binds an onboarded/repaired oracle preparation. */
  async recordComputedPreparation(runId: string, input: {
    binding: OraclePreparationBinding;
    dimensionStatus?: { status: "not-admitted" | "admitted"; sources: string[] };
    reason: string;
  }): Promise<RunAuthorityRecord> {
    const { bindOraclePreparation, setAuthoritativeDimensionStatus } = await import("./state.js");
    const record = await this.store.load(runId);
    const next = clone(record);
    let state = next.embedded.state;
    state = bindOraclePreparation(state, input.binding, input.reason);
    next.oraclePreparationIdentity = input.binding.identity;
    if (input.dimensionStatus) state = setAuthoritativeDimensionStatus(state, input.dimensionStatus.status, input.dimensionStatus.sources);
    next.embedded.state = state;
    // A new preparation invalidates any prior approval and replay (§16/§18).
    this.invalidateReviewAndReplay(next);
    return this.persistComputed(next);
  }

  /** INTERNAL — trusted pipeline only. Records registration evidence computed against the live oracle. */
  async recordComputedRegistration(runId: string, input: {
    artifact: EvidenceArtifact;
    oracleHash: string;
    configHash: string;
    stateAfter?: TaskState;
  }): Promise<RunAuthorityRecord> {
    const { recordEvidenceArtifact, bindEvidenceConfig, bindOracle } = await import("./state.js");
    verifyEvidenceArtifact(input.artifact);
    const record = await this.store.load(runId);
    const next = clone(record);
    let state = input.stateAfter ? clone(input.stateAfter) : next.embedded.state;
    state = bindOracle(state, input.oracleHash);
    state = bindEvidenceConfig(state, "registration", input.configHash, "registration expectation changed");
    state = recordEvidenceArtifact(state, "", input.artifact);
    next.embedded.state = state;
    return this.persistComputed(next);
  }

  /**
   * INTERNAL — trusted pipeline only. Records the COMPLETE authority-owned review binding
   * computed by the trusted capture operation (closure plan §9.F2). Paths are provenance;
   * hashes are authority.
   */
  async recordComputedReviewPacket(runId: string, binding: ReviewBinding): Promise<RunAuthorityRecord> {
    const record = await this.store.load(runId);
    const next = clone(record);
    next.review = {
      ...clone(binding),
      humanApproval: null,
    };
    next.status = "awaiting-human-review";
    return this.persistComputed(next);
  }

  /**
   * INTERNAL — trusted pipeline only. Persists a replay record computed by a fresh trusted
   * global evaluation (closure plan §8.E1). A changed replay hash invalidates the approval.
   */
  async recordComputedReplay(runId: string, replay: TrustedReplayRecord): Promise<RunAuthorityRecord> {
    const record = await this.store.load(runId);
    const next = clone(record);
    if (!replay.passed) throw new Error("a failing replay cannot be recorded as the trusted final replay");
    if (replay.candidateHash !== next.candidateHash) throw new Error("computed replay does not match the canonical candidate");
    if (replay.oraclePreparationIdentity !== next.oraclePreparationIdentity) throw new Error("computed replay does not match the canonical oracle preparation");
    const changed = !next.finalReplay || next.finalReplay.replayHash !== replay.replayHash;
    next.finalReplay = clone(replay);
    next.review.replayHash = replay.replayHash;
    if (changed && next.review.humanApproval) this.invalidateReviewAndReplay(next);
    return this.persistComputed(next);
  }

  /** INTERNAL — trusted pipeline only. Records execution provenance established at runtime. */
  async recordExecutionAuthority(runId: string, execution: NonNullable<RunAuthorityRecord["candidateExecution"]>): Promise<RunAuthorityRecord> {
    const record = await this.store.load(runId);
    const next = clone(record);
    next.candidateExecution = clone(execution);
    return this.persistComputed(next);
  }

  private async saveComputed(runId: string, stateAfter: TaskState, validate: (next: RunAuthorityRecord) => void): Promise<RunAuthorityRecord> {
    const record = await this.store.load(runId);
    const next = clone(record);
    next.embedded.state = clone(stateAfter);
    validate(next);
    return this.persistComputed(next);
  }

  private async persistComputed(next: RunAuthorityRecord): Promise<RunAuthorityRecord> {
    if (next.status === "certified") throw new Error("a certified run no longer accepts computed records");
    next.mirrorSequence += 1;
    await this.store.save(next);
    return next;
  }

  /**
   * Human visual approval enters through a capability unavailable to builder tools. The
   * human acknowledges the CURRENT packet (closure plan §9.F3); every bound hash is read
   * from canonical authority and sealed here, so approval can never become another
   * caller-authored authority object. A current passing replay must already exist.
   */
  async approveReview(runId: string, input: { method: HumanApproval["method"] }, context: RunTransitionContext): Promise<RunAuthorityRecord> {
    assertCapability("record-human-approval", context.requestedBy);
    const record = await this.store.load(runId);
    const next = clone(record);
    const replay = next.finalReplay;
    if (!replay || !replay.passed) throw new Error("human approval requires a passing trusted global replay recorded first");
    if (!next.review.packetHash) throw new Error("human approval requires a prepared review packet");
    const approval: HumanApproval = {
      packetHash: next.review.packetHash,
      candidateHash: next.candidateHash ?? "",
      oraclePreparationIdentity: next.oraclePreparationIdentity ?? "",
      toolchainId: next.toolchain.toolchainId,
      trustedReplayHash: replay.replayHash,
      approvedAt: new Date().toISOString(),
      method: input.method,
    };
    for (const [field, value] of [["candidate", approval.candidateHash], ["oracle preparation", approval.oraclePreparationIdentity]] as const) {
      if (!value) throw new Error(`canonical ${field} is missing; approval cannot be sealed`);
    }
    // The approval also completes the workspace-visible visual-review phase: a human
    // authority artifact is recorded and the phase is marked passed in embedded state.
    const { createWorkflowGateEvidenceArtifact, recordEvidenceArtifact, bindEvidenceConfig } = await import("./state.js");
    let state = next.embedded.state;
    state = bindEvidenceConfig(state, "visual-review", next.review.packetHash, "human approval binds the current review packet");
    const artifact = createWorkflowGateEvidenceArtifact({
      id: `human-approval-${Object.values(state.evidence).filter((item) => item.kind === "visual-review").length + 1}`,
      kind: "visual-review",
      phase: "visual-review",
      oracleHash: state.oracleHash ?? "",
      candidateHash: approval.candidateHash,
      profileContractHash: state.profileContractHash,
      styleContractHash: state.styleContractHash,
      evaluationIdentityHash: state.evaluationIdentityHash,
      configHash: next.review.packetHash,
      gateCode: "visual.review",
      passed: true,
      summary: "final human visual approval sealed through the trusted run authority",
    });
    verifyEvidenceArtifact(artifact);
    state = recordEvidenceArtifact(state, "", artifact);
    state.phaseStatus["visual-review"] = "passed";
    state.visualReviewStatus = "passed";
    next.embedded.state = state;
    next.review.humanApproval = approval;
    next.mirrorSequence += 1;
    await this.store.save(next);
    return next;
  }

  /**
   * Certification recomputes truth from the current record (§17/§18). Historical pass
   * fields never substitute for the fresh replay, current approval, and current policy.
   * Execution authority must be a trusted class (closure plan §6.C5).
   */
  async certify(runId: string, context: RunTransitionContext): Promise<RunAuthorityRecord> {
    assertCapability("certify", context.requestedBy);
    const record = await this.store.load(runId);
    const state = record.embedded.state;
    const problems: string[] = [];
    const executionAuthority = record.candidateExecution?.authority;
    if (executionAuthority !== "trusted-derived-generated" && executionAuthority !== "trusted-host-sandbox") {
      problems.push(`trusted certification requires trusted-derived-generated or trusted-host-sandbox execution (current: ${executionAuthority ?? "unrecorded"})`);
    }
    if (!record.finalReplay?.passed) problems.push("trusted final replay has not passed");
    else {
      if (record.finalReplay.candidateHash !== record.candidateHash) problems.push("trusted final replay is bound to a different candidate");
      if (record.finalReplay.oraclePreparationIdentity !== record.oraclePreparationIdentity) problems.push("trusted final replay is bound to a different oracle preparation");
      if (record.finalReplay.evaluationIdentityHash !== state.evaluationIdentityHash) problems.push("trusted final replay does not match the current evaluation identity");
    }
    const approval = record.review.humanApproval;
    if (!approval) problems.push("human visual approval is missing");
    else {
      if (approval.packetHash !== record.review.packetHash) problems.push("human approval is bound to a different review packet");
      if (approval.candidateHash !== record.candidateHash) problems.push("human approval is bound to a different candidate");
      if (approval.oraclePreparationIdentity !== record.oraclePreparationIdentity) problems.push("human approval is bound to a different oracle preparation");
      if (approval.toolchainId !== record.toolchain.toolchainId) problems.push("human approval is bound to a different toolchain");
      if (!record.finalReplay || approval.trustedReplayHash !== record.finalReplay.replayHash) problems.push("human approval is bound to a different trusted replay");
    }
    if (state.route === "diagnose" || state.status === "blocked") problems.push("run has active diagnose/blocked state");
    const unlocked = Object.entries(state.phaseStatus)
      .filter(([phase, status]) => phase !== "final" && phase !== "visual-review" && status !== "passed" && status !== "skipped")
      .map(([phase]) => phase);
    if (unlocked.length) problems.push(`phases are unlocked: ${unlocked.join(", ")}`);
    else if (state.phaseStatus["visual-review"] !== undefined && state.phaseStatus["visual-review"] !== "passed" && !record.review.humanApproval) {
      problems.push("the visual-review phase requires human approval");
    }
    if (record.policy.authorshipMode === "derived") {
      const { getProfileContract } = await import("./contracts.js");
      const derivable = new Set(getProfileContract(state.profile).phases.filter((phase) => phase.derivable).map((phase) => phase.id));
      const missingBindings = Object.keys(state.locks)
        .filter((phase) => derivable.has(phase) && !state.derivedBindings[`model/.generated/${phase}.mjs`]);
      if (missingBindings.length) problems.push(`derived phases lack current generated bindings: ${missingBindings.join(", ")}`);
    }
    if (problems.length) throw new Error(`certification refused:\n - ${problems.join("\n - ")}`);
    const next = clone(record);
    next.status = "certified";
    next.embedded.state.status = "certified";
    next.embedded.state.phaseStatus.final = "passed";
    next.mirrorSequence += 1;
    await this.store.save(next);
    return next;
  }
}

/** Canonical fields covered by the mirror hash: everything except the mirror bookkeeping itself. */
export function authorityMirrorPayload(record: RunAuthorityRecord): unknown {
  const { mirrorSequence: _mirrorSequence, ...rest } = record;
  void _mirrorSequence;
  return rest;
}

export function authorityMirrorHash(record: RunAuthorityRecord): string {
  return sha256(canonicalJson(authorityMirrorPayload(record)));
}

export interface StateMirror {
  schemaVersion: 1;
  mirrorOfRun: string;
  sequence: number;
  hash: string;
}

/**
 * Builds the workspace mirror metadata that travels inside `.mesh2threejs/state.json`.
 * A mirror whose hash disagrees with the canonical record is WORKSPACE_STATE_DRIFT and the
 * canonical authority wins.
 */
export function stateMirrorFor(record: RunAuthorityRecord): StateMirror {
  return { schemaVersion: 1, mirrorOfRun: record.runId, sequence: record.mirrorSequence, hash: authorityMirrorHash(record) };
}

export function detectWorkspaceStateDrift(mirror: StateMirror | undefined, record: RunAuthorityRecord): string | null {
  if (!mirror) return "workspace state carries no mirror of the trusted run authority";
  if (mirror.mirrorOfRun !== record.runId) return `workspace mirror references run ${mirror.mirrorOfRun}, expected ${record.runId}`;
  if (mirror.hash !== authorityMirrorHash(record)) return "workspace mirror hash disagrees with the canonical authority record";
  if (mirror.sequence > record.mirrorSequence) return "workspace mirror sequence is ahead of the canonical authority record";
  return null;
}

/** Extracts the embedded TaskState for mirroring into the workspace. */
export function mirroredTaskState(record: RunAuthorityRecord): TaskState {
  return clone(record.embedded.state);
}

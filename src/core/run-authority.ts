import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AuthorshipMode, CertificationLevel, ProfileId } from "../types.js";
import {
  acceptPhase,
  bindCandidatePhases,
  bindOraclePreparation,
  recordAttempt,
  recordEvidenceArtifact,
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
  candidateIsolation: "development-process" | "trusted-isolated" | "unconfigured";
  review: { packetHash: string | null; humanApproval: HumanApproval | null };
  finalReplay: TrustedReplayRecord | null;
  viewerStartApproved: boolean;
  status: "active" | "awaiting-human-review" | "certified";
  mirrorSequence: number;
  embedded: RunAuthorityRecordState;
}

export type BuilderAction =
  | { kind: "bind-oracle-preparation"; binding: OraclePreparationBinding; reason: string }
  | { kind: "record-evidence"; artifacts: EvidenceArtifact[] }
  | { kind: "lock-phase"; phase: string }
  | { kind: "reopen-phase"; phase: string; reason: string }
  | { kind: "record-attempt"; action: string; evidenceHash: string; score: number }
  | { kind: "set-candidate"; candidateHash: string; phaseGeometryHashes: Record<string, string> }
  | { kind: "mark-review-ready"; packetHash: string }
  | { kind: "set-viewer-approved" };

/** Runtime-computed records; never accepted from builder-supplied values. */
export type RuntimeRecord =
  | { kind: "final-replay"; replay: TrustedReplayRecord }
  | { kind: "derived-bindings"; bindings: Record<string, DerivedBinding> }
  | { kind: "candidate-isolation"; isolation: "development-process" | "trusted-isolated" };

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
    // the builder, and even then every non-default field must carry its decision record.
    assertCapability("create-run", input.requestedBy);
    validatePolicyCreation(input.policy, input.policyDecisions, input.defaults);
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
      candidateIsolation: "unconfigured",
      review: { packetHash: null, humanApproval: null },
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
   * Applies a builder-safe transition. Every branch validates against the CURRENT canonical
   * truth and mutates only through the same pure pipeline functions the development CLI uses,
   * so trusted bookkeeping can never drift from the pipeline's own rules.
   */
  async applyBuilderTransition(runId: string, action: BuilderAction, context: RunTransitionContext): Promise<RunAuthorityRecord> {
    // Builder-safe transitions accept builder or admin callers; the viewer-start approval
    // inside this union is human/admin-only (§19).
    if (action.kind === "set-viewer-approved" && context.requestedBy !== "human-admin") {
      assertCapability("viewer-start", context.requestedBy);
    }
    if (context.requestedBy !== "builder" && context.requestedBy !== "human-admin") throw new Error(`unsupported capability for builder transitions: ${context.requestedBy}`);
    const record = await this.store.load(runId);
    if (record.status === "certified") throw new Error(`trusted run ${runId} is already certified; no further builder transitions apply`);
    const next = clone(record);
    const state = next.embedded.state;
    switch (action.kind) {
      case "bind-oracle-preparation": {
        const bound = bindOraclePreparation(state, action.binding, action.reason);
        next.embedded.state = bound;
        next.oraclePreparationIdentity = action.binding.identity;
        // A new preparation invalidates any prior approval and replay (§16/§18).
        next.review.humanApproval = null;
        next.finalReplay = null;
        if (next.status === "awaiting-human-review") next.status = "active";
        break;
      }
      case "record-evidence": {
        let updated = state;
        for (const artifact of action.artifacts) {
          verifyEvidenceArtifact(artifact);
          updated = recordEvidenceArtifact(updated, artifact.id, artifact);
        }
        next.embedded.state = updated;
        break;
      }
      case "set-candidate": {
        const changed = next.candidateHash !== null && next.candidateHash !== action.candidateHash;
        const updated = bindCandidatePhases(state, action.candidateHash, action.phaseGeometryHashes);
        next.embedded.state = updated;
        next.candidateHash = action.candidateHash;
        if (changed) {
          // Candidate changed: approval and replay are invalidated (§22 attacks 50–51).
          next.review.humanApproval = null;
          next.finalReplay = null;
          if (next.status === "awaiting-human-review") next.status = "active";
        }
        break;
      }
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
        const updated = reopenPhase(state, action.phase, action.reason);
        next.embedded.state = updated;
        next.review.humanApproval = null;
        next.finalReplay = null;
        if (next.status === "awaiting-human-review") next.status = "active";
        break;
      }
      case "record-attempt": {
        next.embedded.state = recordAttempt(state, { action: action.action, evidenceHash: action.evidenceHash, score: action.score });
        break;
      }
      case "mark-review-ready": {
        next.review.packetHash = action.packetHash;
        next.status = "awaiting-human-review";
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

  /** Records runtime-derived results. Values come from trusted runtime code paths only. */
  async applyRuntimeRecord(runId: string, recordInput: RuntimeRecord): Promise<RunAuthorityRecord> {
    const record = await this.store.load(runId);
    const next = clone(record);
    switch (recordInput.kind) {
      case "final-replay": {
        if (!recordInput.replay.passed) throw new Error("a failing replay cannot be recorded as the trusted final replay");
        next.finalReplay = clone(recordInput.replay);
        break;
      }
      case "derived-bindings": {
        next.embedded.state.derivedBindings = clone(recordInput.bindings);
        break;
      }
      case "candidate-isolation": {
        next.candidateIsolation = recordInput.isolation;
        break;
      }
      default: {
        const exhaustive: never = recordInput;
        throw new Error(`unsupported runtime record: ${JSON.stringify(exhaustive)}`);
      }
    }
    next.mirrorSequence += 1;
    await this.store.save(next);
    return next;
  }

  /**
   * Human visual approval enters through a capability unavailable to builder tools. The
   * approval binds the exact packet, candidate, oracle preparation, toolchain, and trusted
   * replay hash current at approval time; anything that changes later invalidates it.
   */
  async recordHumanApproval(runId: string, approval: Omit<HumanApproval, "approvedAt">, context: RunTransitionContext): Promise<RunAuthorityRecord> {
    assertCapability("record-human-approval", context.requestedBy);
    const record = await this.store.load(runId);
    const next = clone(record);
    const replay = next.finalReplay;
    if (!replay || !replay.passed) throw new Error("human approval requires a passing trusted global replay recorded first");
    if (approval.packetHash !== next.review.packetHash) throw new Error("human approval does not bind the current review packet");
    if (approval.candidateHash !== next.candidateHash) throw new Error("human approval does not bind the current candidate");
    if (approval.oraclePreparationIdentity !== next.oraclePreparationIdentity) throw new Error("human approval does not bind the current oracle preparation");
    if (approval.toolchainId !== next.toolchain.toolchainId) throw new Error("human approval does not bind the current toolchain");
    if (approval.trustedReplayHash !== replay.replayHash) throw new Error("human approval does not bind the current trusted replay");
    if (!next.review.packetHash) throw new Error("human approval requires a prepared review packet");
    next.review.humanApproval = { ...clone(approval), approvedAt: new Date().toISOString() };
    next.mirrorSequence += 1;
    await this.store.save(next);
    return next;
  }

  /**
   * Certification recomputes truth from the current record (§17/§18). Historical pass
   * fields never substitute for the fresh replay, current approval, and current policy.
   */
  async certify(runId: string, context: RunTransitionContext): Promise<RunAuthorityRecord> {
    assertCapability("certify", context.requestedBy);
    const record = await this.store.load(runId);
    const state = record.embedded.state;
    const problems: string[] = [];
    if (record.candidateIsolation !== "trusted-isolated") problems.push(`trusted certification requires a trusted-isolated candidate sandbox (current: ${record.candidateIsolation})`);
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
    const unlocked = Object.entries(state.phaseStatus).filter(([phase, status]) => phase !== "final" && status !== "passed" && status !== "skipped").map(([phase]) => phase);
    if (unlocked.length) problems.push(`phases are unlocked: ${unlocked.join(", ")}`);
    if (record.policy.authorshipMode === "derived") {
      const missingBindings = Object.keys(state.locks).filter((phase) => phase !== "oracle-registration" && !state.derivedBindings[`model/.generated/${phase}.mjs`]);
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

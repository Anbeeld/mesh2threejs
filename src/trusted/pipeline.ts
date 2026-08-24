import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as THREE from "three";
import { resumeWorkspace, initializeWorkspace, createWorkspaceResolver, verifyWorkspaceOraclePreparation, type ResumedWorkspace } from "../core/workspace.js";
import { recordEvidenceArtifact, isAuthoritativeEvidence, createWorkflowGateEvidenceArtifact, type EvidenceArtifact, type TaskState } from "../core/state.js";
import { TrustedRunAuthority, mirroredTaskState, stateMirrorFor, detectWorkspaceStateDrift, type RunAuthorityRecord, type ReviewBinding, type RunTransitionContext } from "../core/run-authority.js";
import { computeSafeDefaultPolicy, projectPolicyIdentity, type PolicyDecision } from "../core/policy.js";
import { assertCapability, type Capability } from "../core/capabilities.js";
import { establishToolchain, type VerifiedToolchain } from "../core/toolchain.js";
import type { CandidateExecutionAuthority } from "../core/exec-authority.js";
import { routeSubject } from "../core/routing.js";
import { canonicalJson, fingerprintScene, sha256 } from "../core/hashing.js";
import { getProfileContract } from "../core/contracts.js";
import { neutralPoseForProfile, requiredPosesForProfile } from "../core/orchestration.js";
import {
  loadPreparedOracle,
  onboardOracle,
  oraclePreparationBinding,
  repairPreparedOracle,
  verifyOracleRegistration,
  type OnboardOracleInput,
  type RegistrationExpectation,
  type RepairPreparedOracleInput,
} from "../core/oracle.js";
import { evaluateAssemblyCoverage } from "../core/assembly.js";
import { derivePhaseSeed } from "../core/derive.js";
import { verifyDerivedLineage, derivedDirectory, loadTrustedGeneratedModules } from "../core/derivation.js";
import { performRenderRun, performOracleSanityRun, performQuickDiagnosticRun, verifyLatestOracleSanity } from "../core/workspace-render.js";import { createVisualReviewPacket, verifyVisualReviewPacketFiles, type ReviewFileReference } from "../core/review.js";
import { serializeScene } from "../core/scene-serialization.js";
import { trustedDerivedBackend } from "../core/candidate-sandbox.js";
import { inspectWorkspaceCandidateViaExecutor, computeWorkspaceGate, applyGateEvidence, workspaceGateOutcome } from "../operations/workspace-gate.js";

/**
 * THE trusted reconstruction pipeline (closure plan §3/F1). One internal operation layer
 * performs the real workflow: it loads canonical run policy/state itself, executes the
 * operation with trusted package code, verifies outputs, updates the canonical authority,
 * and mirrors to the workspace only afterwards (§4.A4). Builder payloads carry DATA inputs
 * (repair JSON, registration expectations) and semantic requests — never runtime pass/fail
 * facts, evidence, isolation labels, replay records, packet hashes, or certification state.
 */

export class PipelineError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "PipelineError";
  }
}

/**
 * Reusable trusted replay execution bundle (remaining closure §3): ONE authorized candidate
 * execution whose serialized scenes feed gates, renders, viewer artifacts and review
 * packets without any second candidate import.
 */
export interface TrustedReplayBundle {
  replayHash: string;
  candidateHash: string;
  evaluationIdentityHash: string;
  executionAuthority: CandidateExecutionAuthority;
  neutralSceneHash: string;
  neutralSerialization: ReturnType<typeof serializeScene>;
  neutralRoot: THREE.Object3D;
  posedRoots: Array<{ pose: Record<string, number>; root: THREE.Object3D }>;
}

export interface TrustedPipelineOptions {
  authority: TrustedRunAuthority;
  /** Package root for toolchain identity; defaults to this installation. */
  packageRoot?: string;
  /** Test hook: fixed verified toolchain instead of establishing from disk. */
  toolchain?: VerifiedToolchain;
  /**
   * Broker-private execution scratch root (final closure §2). Trusted candidate staging is
   * created INSIDE this directory — outside the workspace, repo, and builder-writable space
   * — so a workspace mutation after authorization cannot affect the private staged copy.
   * Required for trusted runs; omitted in tests that inject their own staging.
   */
  executionScratchRoot?: string;
}

export class TrustedPipeline {
  readonly authority: TrustedRunAuthority;
  private readonly toolchainPromise: Promise<VerifiedToolchain>;
  private toolchainValue: VerifiedToolchain | null = null;
  private readonly executionScratchRoot: string | null;

  constructor(options: TrustedPipelineOptions) {
    this.authority = options.authority;
    this.executionScratchRoot = options.executionScratchRoot ?? null;
    if (options.toolchain) {
      this.toolchainValue = options.toolchain;
      this.toolchainPromise = Promise.resolve(options.toolchain);
    } else {
      this.toolchainPromise = establishToolchain(resolve(options.packageRoot ?? import.meta.dirname, "..", ".."));
    }
  }

  async toolchain(): Promise<VerifiedToolchain> {
    if (!this.toolchainValue) this.toolchainValue = await this.toolchainPromise;
    return this.toolchainValue;
  }

  // ---------------------------------------------------------------- mirroring (A4/H4)

  /**
   * Canonical-first persistence (§4.A4): the canonical store was already updated by the
   * authority; this derives and atomically writes the workspace mirror. A mirror failure is
   * surfaced but never rolls back canonical truth; the next operation repairs the mirror.
   */
  private async commitCanonicalAndMirror(record: RunAuthorityRecord): Promise<void> {
    const statePath = join(record.workspaceRoot, ".mesh2threejs", "state.json");
    const mirrorState: TaskState = { ...mirroredTaskState(record), mirrorOfRun: stateMirrorFor(record) };
    try {
      await mkdir(dirname(statePath), { recursive: true });
      const temporary = `${statePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(mirrorState, null, 2)}\n`);
      await rename(temporary, statePath);
    } catch (error) {
      throw new PipelineError("WORKSPACE_MIRROR_WRITE_FAILED", `canonical authority was updated but the workspace mirror could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Loads the workspace for a run, repairing a stale/tampered mirror from canonical truth
   * first (§11.H4). The workspace copy is a cache; it is never a competing authority. Byte
   * contradictions of project/reference inputs are NOT silently rebound — callers surface
   * them as drift blocks.
   */
  private async loadRunWorkspace(record: RunAuthorityRecord): Promise<ResumedWorkspace> {
    const statePath = join(record.workspaceRoot, ".mesh2threejs", "state.json");
    let raw: Record<string, unknown> | null = null;
    try {
      raw = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    } catch { /* absent or unreadable: resume will recreate what it can */ }
    const existingMirror = raw?.mirrorOfRun as Record<string, unknown> | undefined;
    if (existingMirror && existingMirror.mirrorOfRun !== record.runId) {
      throw new PipelineError("WORKSPACE_BOUND_TO_OTHER_RUN", `workspace is bound to run ${String(existingMirror.mirrorOfRun)}, not ${record.runId}`);
    }
    if (existingMirror || raw) {
      // Rewrite the mirror from canonical before resuming so stale or tampered copies
      // cannot influence operation preconditions.
      await this.commitCanonicalAndMirror(record).catch(async (error) => {
        if (raw === null) throw error;
        // If the directory cannot be written yet, fall through: resumeWorkspace may still work.
      });
    }
    return resumeWorkspace(record.workspaceRoot);
  }

  /** Verifies project/reference/toolchain bindings against canonical policy (§5.B3/H4). */
  private async assertBindingsCurrent(record: RunAuthorityRecord, workspace: ResumedWorkspace): Promise<void> {
    const toolchain = await this.toolchain();
    if (record.toolchain.toolchainId !== toolchain.toolchainId) {
      throw new PipelineError("TOOLCHAIN_DRIFT", `trusted run is bound to toolchain ${record.toolchain.toolchainId} but installation verifies as ${toolchain.toolchainId}`);
    }
        // Any project edit that would change the bound policy (authorship, profile, style,
    // certification, goal, subject contract, oracle selection) is drift - never a silent rebind.
    const currentPolicy = canonicalJson(projectPolicyIdentity(workspace.project, workspace.references));
    if (currentPolicy !== canonicalJson(record.policy)) {
      throw new PipelineError("POLICY_INPUT_DRIFT", "workspace project/reference inputs no longer match the canonical run policy; administrative rebase is required");
    }    // Reference bytes: the selected oracle file must still hash to the admitted value.
    if (record.policy.oracleReference) {
      const reference = workspace.references.records.find((entry) => entry.kind === "oracle" && entry.operationalPath === workspace.project.oracle);
      if (!reference || reference.sha256 !== record.policy.oracleReference.sha256) {
        throw new PipelineError("POLICY_INPUT_DRIFT", "the selected oracle reference bytes changed after the run began; administrative rebase is required");
      }
    }
  }

  private async loadRecord(runId: string): Promise<RunAuthorityRecord> {
    const record = await this.authority.readRun(runId);
    if (record.status === "certified") throw new PipelineError("RUN_CERTIFIED", `trusted run ${runId} is already certified`);
    return record;
  }

  private context(capability: Capability): RunTransitionContext {
    return { requestedBy: capability };
  }

  // ---------------------------------------------------------------- begin-run (A3)

  /**
   * Safe-default autonomous run creation over an EXISTING workspace (§4.A3). The request
   * identifies the workspace only; policy is computed by trusted code from immutable
   * reference bytes, the router, and package defaults. NOTE (remaining closure §6.3): this
   * path trusts whatever goal/oracle the builder already placed in the workspace — it
   * carries `builder-prepared` intake provenance and cannot claim end-to-end trusted input
   * authority unless the initial goal/oracle were pinned by host/user authority.
   */
  async beginRun(input: { workspaceRoot: string; runId?: string }, capability: Capability): Promise<{ runId: string }> {
    const workspace = await resumeWorkspace(input.workspaceRoot);
    if (workspace.state.mirrorOfRun) {
      throw new PipelineError("WORKSPACE_ALREADY_BOUND", `workspace is already bound to trusted run ${workspace.state.mirrorOfRun.mirrorOfRun}`);
    }
    return this.bindSafeDefaultRun(workspace, "builder-prepared", capability, input.runId);
  }

  /**
   * TRUSTED INTAKE (remaining closure §6.1): a host/user-facing operation that pins the
   * original goal and oracle bytes BEFORE any builder-controlled mutation can redefine the
   * workspace. Trusted code routes the profile and computes every policy field — the
   * builder never supplies profile, authorship mode, certification, style, or thresholds.
   */
  async createWorkspaceRun(input: { workspaceRoot: string; goal: string; oraclePath: string; workspaceId?: string }, capability: Capability): Promise<{ runId: string; intake: string }> {
    assertCapability("create-workspace-run", capability);
    const routedProfile = routeSubject(input.goal);
    if (!/^[\w.-]+$/u.test(basename(input.oraclePath)) && !/\.glb$/iu.test(input.oraclePath)) {
      throw new PipelineError("INVALID_ORACLE", "oraclePath must point at a .glb source model");
    }
    const initialized = await initializeWorkspace(resolve(input.workspaceRoot), {
      id: input.workspaceId ?? basename(resolve(input.workspaceRoot)),
      goal: input.goal,
      profile: routedProfile,
      style: "low-poly-faithful",
      certification: "oracle-relative",
      oracle: input.oraclePath,
      referenceMode: "copy",
      authorshipMode: "derived",
    });
    const workspace = await resumeWorkspace(initialized.root);
    if (workspace.state.mirrorOfRun) {
      throw new PipelineError("WORKSPACE_ALREADY_BOUND", `workspace is already bound to trusted run ${workspace.state.mirrorOfRun.mirrorOfRun}`);
    }
    const result = await this.bindSafeDefaultRun(workspace, "trusted", capability);
    return { runId: result.runId, intake: "trusted" };
  }

  /** Shared safe-default binding: route + policy computation + canonical run creation. */
  private async bindSafeDefaultRun(workspace: ResumedWorkspace, intake: "trusted" | "builder-prepared", capability: Capability, runIdInput?: string): Promise<{ runId: string }> {
    const routedProfile = routeSubject(workspace.project.goal);
    const computed = computeSafeDefaultPolicy({
      project: workspace.project,
      references: workspace.references,
      routedProfile,
      defaultStyle: "low-poly-faithful",
      defaultCertification: "oracle-relative",
    });
    if ("blocked" in computed) {
      throw new PipelineError(computed.blocked, `the project requests non-default policy; administrative approval is required (${computed.conflicts.join("; ")})`, computed.conflicts);
    }
    const toolchain = await this.toolchain();
    const runId = runIdInput ?? `run-${sha256(canonicalJson({ root: resolve(workspace.root), at: Date.now(), random: Math.random().toString(36) })).slice(0, 12)}`;
    await this.authority.createRun({
      runId,
      workspaceRoot: workspace.root,
      policy: computed.policy,
      policyDecisions: computed.decisions,
      initialState: workspace.state,
      toolchain: {
        runtimeHash: toolchain.manifest.runtimeHash,
        controlHash: toolchain.manifest.controlHash,
        dependencyIdentity: toolchain.manifest.dependencyIdentity,
        packageVersion: toolchain.manifest.packageVersion,
        toolchainId: toolchain.toolchainId,
      },
      intake,
      defaults: { hasOracle: Boolean(workspace.project.oracle), routedProfile },
      requestedBy: capability,
    });
    const record = await this.authority.readRun(runId);
    await this.commitCanonicalAndMirror(record);
    return { runId };
  }

  // ---------------------------------------------------------------- status/next

  async status(runId: string): Promise<Record<string, unknown>> {
    const record = await this.loadRecord(runId);
    const state = record.embedded.state;
    return {
      runId,
      status: record.status,
      taskId: state.taskId,
      route: state.route,
      activePhase: state.activePhase,
      phaseStatus: state.phaseStatus,
      visualReviewStatus: state.visualReviewStatus,
      locks: Object.keys(state.locks),
      unresolvedItems: state.unresolvedItems,
      review: {
        packetHash: record.review.packetHash,
        awaitingHuman: record.status === "awaiting-human-review",
        humanApproval: record.review.humanApproval ? { approvedAt: record.review.humanApproval.approvedAt, method: record.review.humanApproval.method } : null,
      },
    };
  }

  async next(runId: string): Promise<Record<string, unknown>> {
    const record = await this.loadRecord(runId);
    const { determineNextAction } = await import("../core/state.js");
    return { runId, activePhase: record.embedded.state.activePhase, ...determineNextAction(record.embedded.state) };
  }

  // ---------------------------------------------------------------- oracle lifecycle

  async onboardOracle(runId: string, config: OnboardOracleInput, capability: Capability): Promise<Record<string, unknown>> {
    const record = await this.loadRecord(runId);
    const workspace = await this.loadRunWorkspace(record);
    await this.assertBindingsCurrent(record, workspace);
    if (!workspace.project.oracle) throw new PipelineError("NO_ORACLE", "workspace has no oracle reference to onboard");
    const oracleRecord = workspace.references.records.find((entry) => entry.kind === "oracle" && entry.operationalPath === workspace.project.oracle);
    if (!oracleRecord) throw new PipelineError("ORACLE_NOT_INDEXED", "workspace oracle is absent from the reference index");
    const resolver = await import("../core/workspace.js").then((m) => m.createWorkspaceResolver(workspace.root));
    const manifest = await onboardOracle({
      ...config,
      workspaceRoot: workspace.root,
      sourcePath: oracleRecord.operationalPath,
      sourceOriginalPath: oracleRecord.originalPath,
      referenceMode: oracleRecord.mode,
      preparedPath: resolver.toProjectPath(workspace.layout.internal.preparedOracle),
    });
    await mkdir(dirname(workspace.layout.internal.oracleManifest), { recursive: true });
    await writeFile(workspace.layout.internal.oracleManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    const binding = oraclePreparationBinding(manifest);
    const requiredDimensions = getProfileContract(record.policy.profile).dimensions;
    const dimensions = manifest.authoritativeDimensions;
    const admitted = Boolean(dimensions && manifest.dimensionSources.length && requiredDimensions.every((key) => Number.isFinite(dimensions[key]) && dimensions[key]! > 0));
    const next = await this.authority.recordComputedPreparation(runId, {
      binding,
      dimensionStatus: admitted ? { status: "admitted", sources: manifest.dimensionSources } : { status: "not-admitted", sources: [] },
      reason: `oracle onboarding admitted preparation ${manifest.preparedHash}`,
    });
    await this.commitCanonicalAndMirror(next);
    return { status: "onboarded", preparedHash: manifest.preparedHash, sourceHash: manifest.sourceHash };
  }

  async repairOracle(runId: string, config: Omit<RepairPreparedOracleInput, "preparedPath"> & { preparedPath?: string }): Promise<Record<string, unknown>> {
    const record = await this.loadRecord(runId);
    const workspace = await this.loadRunWorkspace(record);
    await this.assertBindingsCurrent(record, workspace);
    const preparation = await verifyWorkspaceOraclePreparation(workspace);
    const repaired = await repairPreparedOracle(preparation.manifest, {
      ...config,
      preparedPath: `.mesh2threejs/oracle/prepared-repair-${preparation.manifest.repairHistory.length + 1}.json`,
    }, workspace.root);
    await writeFile(workspace.layout.internal.oracleManifest, `${JSON.stringify(repaired, null, 2)}\n`);
    const next = await this.authority.recordComputedPreparation(runId, {
      binding: oraclePreparationBinding(repaired),
      reason: `oracle repair: ${config.reason ?? "unspecified reason"}`,
    });
    await this.commitCanonicalAndMirror(next);
    return { status: "repaired", preparedHash: repaired.preparedHash };
  }

  async register(runId: string, expectation: RegistrationExpectation): Promise<Record<string, unknown>> {
    const record = await this.loadRecord(runId);
    const workspace = await this.loadRunWorkspace(record);
    await this.assertBindingsCurrent(record, workspace);
    const preparation = await verifyWorkspaceOraclePreparation(workspace);
    const oracle = await loadPreparedOracle(preparation.manifest, workspace.root);
    const evidence = verifyOracleRegistration(oracle, expectation, { profile: record.policy.profile });
    const assemblyCoverage = record.policy.profile === "tank" ? evaluateAssemblyCoverage(oracle, "tank") : undefined;
    const passed = evidence.passed && (assemblyCoverage?.passed ?? true);
    const configHash = sha256(canonicalJson({ expectation, oraclePreparation: preparation.binding.identity }));
    const artifact = createWorkflowGateEvidenceArtifact({
      id: `registration-${record.mirrorSequence + 1}`,
      kind: "registration",
      phase: "oracle-registration",
      oracleHash: fingerprintScene(oracle),
      candidateHash: null,
      profileContractHash: record.embedded.state.profileContractHash,
      styleContractHash: record.embedded.state.styleContractHash,
      evaluationIdentityHash: null,
      configHash,
      gateCode: "registration.complete",
      passed,
      summary: passed ? "reference registration passed" : `reference registration failed${assemblyCoverage && !assemblyCoverage.passed ? `: ${assemblyCoverage.unresolved.length} significant source mesh(es) lack phase ownership` : ""}`,
      details: { registration: evidence, ...(assemblyCoverage ? { assemblyCoverage } : {}) },
    });
    const reportPath = join(workspace.layout.internal.reports, `registration-${artifact.id}.json`);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({ ...evidence, ...(assemblyCoverage ? { assemblyCoverage } : {}), passed })}\n`);
    const next = await this.authority.recordComputedRegistration(runId, {
      artifact,
      oracleHash: artifact.oracleHash!,
      configHash,
    });
    await this.commitCanonicalAndMirror(next);
    return {
      status: passed ? "registered" : "registration-failed",
      passed,
      ...(assemblyCoverage && !assemblyCoverage.passed ? { unresolvedAssemblies: assemblyCoverage.unresolved.map((item) => item.objectId) } : {}),
    };
  }

  async oracleSanity(runId: string): Promise<Record<string, unknown>> {
    const record = await this.loadRecord(runId);
    const workspace = await this.loadRunWorkspace(record);
    await this.assertBindingsCurrent(record, workspace);
    const preparation = await verifyWorkspaceOraclePreparation(workspace);
    const oracle = await loadPreparedOracle(preparation.manifest, workspace.root);
    const result = await performOracleSanityRun(workspace, preparation.manifest, oracle);
    return { status: "oracle-sanity-captured", views: result.views, note: "builder/onboarding sanity evidence; not external visual certification" };
  }

  // ---------------------------------------------------------------- builder information loop (remaining closure §7)

  /** Read-only oracle facts for autonomous onboarding (§7.1); never mutates anything. */
  async probe(runId: string): Promise<Record<string, unknown>> {
    const record = await this.loadRecord(runId);
    const workspace = await this.loadRunWorkspace(record);
    await this.assertBindingsCurrent(record, workspace);
    if (!workspace.project.oracle) throw new PipelineError("NO_ORACLE", "workspace has no oracle reference to probe");
    const oracleRecord = workspace.references.records.find((entry) => entry.kind === "oracle" && entry.operationalPath === workspace.project.oracle);
    if (!oracleRecord) throw new PipelineError("ORACLE_NOT_INDEXED", "workspace oracle is absent from the reference index");
    const { probeGlb } = await import("../core/oracle.js");
    const bytes = await readFile(this.resolveWorkspace(oracleRecord.operationalPath, workspace));
    return {
      runId,
      intake: record.intake,
      profile: record.policy.profile,
      oracleHash: oracleRecord.sha256,
      status: "probed",
      oraclePath: oracleRecord.operationalPath,
      sha256: oracleRecord.sha256,
      facts: probeGlb(bytes),
      note: "read-only oracle facts for semantic onboarding; use onboard-oracle to bind them",
    };
  }

  /** Current authoritative failing workorders from canonical trusted evidence (§7.2). */
  async workorders(runId: string): Promise<Record<string, unknown>> {
    const record = await this.loadRecord(runId);
    void record;
    const state = (await this.authority.readRun(runId)).embedded.state;
    const activePhase = state.activePhase;
    const latest = Object.values(state.evidence)
      .filter((item) => item.kind === "deterministic-gate" && item.phase === activePhase && item.valid && item.artifact)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    let latestGate: Record<string, unknown> | null = null;
    let workorders: Array<Record<string, unknown>> = [];
    if (latest?.artifact) {
      try {
        const report = JSON.parse(await readFile(this.resolveWorkspace(latest.artifact, await this.loadRunWorkspace(record)), "utf8")) as { report?: { passed?: boolean; score?: number; workorders?: Array<Record<string, unknown>>, rows?: Array<{ passed: boolean; code: string }> } };
        const inner = report.report ?? report as never;
        latestGate = { evidenceId: latest.id, phase: latest.phase, createdAt: latest.createdAt, ...(inner.passed !== undefined ? { passed: inner.passed } : {}), ...(inner.score !== undefined ? { score: inner.score } : {}), failingCodes: (inner.rows ?? []).filter((row) => !row.passed).map((row) => row.code) };
        workorders = inner.workorders ?? [];
      } catch { /* unreadable artifact falls through to empty workorders */ }
    }
    const { determineNextAction } = await import("../core/state.js");
    const nextAction = determineNextAction(state);
    return {
      runId,
      activePhase,
      workorders,
      latestGate,
      stagnation: { attempts: state.attempts.length, route: state.route },
      nextAction,
    };
  }

  /**
   * Trusted builder diagnostic render of the ACTIVE phase through the SAME authorized
   * candidate execution graph (bounded child, byte-verified authority). Quick captures are
   * never review or certification evidence and never start a viewer.
   */
  async renderQuick(runId: string): Promise<Record<string, unknown>> {
    const record = await this.loadRecord(runId);
    const workspace = await this.loadRunWorkspace(record);
    await this.assertBindingsCurrent(record, workspace);
    const manifest = await verifyWorkspaceOraclePreparation(workspace);
    const oracle = await loadPreparedOracle(manifest.manifest, workspace.root);
    const execution = await inspectWorkspaceCandidateViaExecutor({
      workspaceRoot: workspace.root,
      modelEntryPath: workspace.resolved.model,
      boundaryRoot: resolve(workspace.root, "model"),
      poses: [neutralPoseForProfile(workspace.project.profile)],
      auditOptions: await (await import("../core/derive.js")).trustedGeneratedAuditOptions(workspace, manifest.binding.identity),
      trusted: true,
      ...(this.executionScratchRoot ? { executionScratchRoot: this.executionScratchRoot } : {}),
    });
    const result = await performQuickDiagnosticRun(workspace, manifest.manifest, oracle, { candidateHash: execution.candidateHash }, execution.neutralRoot);
    return {
      status: "quick-render-captured",
      activePhase: workspace.state.activePhase,
      directory: this.toProjectPath(result.directory, workspace),
      boards: result.boards.map((board) => this.toProjectPath(board.path, workspace)),
      captures: result.captures,
      note: "builder diagnostic only; not review or certification evidence",
    };
  }

  // ---------------------------------------------------------------- derive/gate/lock/reopen

  async derive(runId: string, options: { quality?: "aggressive" | "balanced" | "conservative" } = {}, capability: Capability): Promise<Record<string, unknown>> {
    const record = await this.loadRecord(runId);
    const workspace = await this.loadRunWorkspace(record);
    await this.assertBindingsCurrent(record, workspace);
    const preparation = await verifyWorkspaceOraclePreparation(workspace);
    const preparationIdentity = preparation.binding.identity;
    // persistState routes durable binding mutations through the CANONICAL authority.
    const persistState = async (state: TaskState): Promise<TaskState> => {
      const next = await this.authority.recordComputedDerivedBindings(runId, {
        bindings: state.derivedBindings,
        preparationIdentity,
        ...(state.candidateHash ? { candidateHash: state.candidateHash } : {}),
        phaseGeometryHashes: state.phaseGeometryHashes,
        stateAfter: state,
      });
      await this.commitCanonicalAndMirror(next);
      return next.embedded.state;
    };
    const result = await derivePhaseSeed(workspace.root, {
      ...(options.quality ? { quality: options.quality } : {}),
      persistState,
      // Tier trials execute the pipeline-owned composition in the bounded child process —
      // never inside the broker (remaining closure §2.6/§2.7).
      backend: trustedDerivedBackend(),
      ...(this.executionScratchRoot ? { executionScratchRoot: this.executionScratchRoot } : {}),
    });
    // Lineage re-verification against canonical bindings (defense in depth).
    const fresh = await this.authority.readRun(runId);
    await verifyDerivedLineage({
      modelEntryPath: workspace.resolved.model,
      workspaceRoot: workspace.root,
      profile: workspace.project.profile,
      authorshipMode: "derived",
      derivedBindings: fresh.embedded.state.derivedBindings,
      trustedModules: await loadTrustedGeneratedModules({
        directory: derivedDirectory(workspace.layout.internal.root),
        workspaceRoot: workspace.root,
        preparationIdentity,
        bindings: fresh.embedded.state.derivedBindings,
        allowedPhases: new Set(getProfileContract(workspace.project.profile).phases.filter((item) => item.owner === "builder").map((item) => item.id)),
      }),
    });
    return { status: result.status, phase: result.phase, operator: result.operator, tiers: result.tiers, ...(result.selected ? { selected: result.selected } : {}), ...(result.note ? { note: result.note } : {}) };
  }

  async gate(runId: string, options: { global?: boolean } = {}, _capability: Capability): Promise<Record<string, unknown>> {
    void _capability;
    const record = await this.loadRecord(runId);
    const workspace = await this.loadRunWorkspace(record);
    await this.assertBindingsCurrent(record, workspace);
    const isGlobal = options.global ?? false;
    const runTag = `gate-${record.runId}-${record.mirrorSequence + 1}`;
    const computation = await computeWorkspaceGate(workspace, {
      isGlobal,
      toolchainId: record.toolchain.toolchainId,
      projectPolicyHash: record.projectPolicyHash,
      artifactRunId: runTag,
      trusted: true,
      ...(this.executionScratchRoot ? { executionScratchRoot: this.executionScratchRoot } : {}),
    });
    // Persist evidence artifacts into the workspace reports tree (provenance paths).
    const evidenceDirectory = join(workspace.layout.internal.evidence, runTag);
    await mkdir(evidenceDirectory, { recursive: true });
    const recordedArtifacts: EvidenceArtifact[] = [];
    for (const item of computation.artifacts) {
      const artifactPath = join(evidenceDirectory, `${item.suggestedId}.json`);
      await writeFile(artifactPath, `${JSON.stringify(item.artifact, null, 2)}\n`, { flag: "wx" });
      recordedArtifacts.push(item.artifact);
    }
    const relativePath = (artifact: EvidenceArtifact): string => `.mesh2threejs/evidence/${runTag}/${artifact.id}.json`;
    // Apply the SAME pure mutation the CLI uses, then record canonically via internal channels:
    // candidate identity -> gate evidence -> execution authority. None of these values are
    // caller-supplied; every one is computed above by trusted package code.
    const baseState = record.embedded.state;
    const mutated = applyGateEvidence(baseState, computation, (state, artifact) => recordEvidenceArtifact(state, relativePath(artifact), artifact), computation.evaluationIdentity);
    const withCandidate = await this.authority.recordComputedCandidate(runId, {
      candidateHash: computation.evaluation.candidateHash,
      phaseGeometryHashes: computation.evaluation.phaseGeometryHashes,
      evaluationIdentity: computation.evaluationIdentity,
      stateAfter: mutated,
    });
    const next = await this.authority.recordComputedGate(runId, {
      phase: isGlobal ? null : workspace.state.activePhase,
      passed: isGlobal ? computation.evaluation.passed : (computation.evaluation.phaseGates[workspace.state.activePhase]?.passed ?? false),
      evaluationIdentityHash: computation.evaluationIdentityHash,
      artifacts: recordedArtifacts,
      stateAfter: withCandidate.embedded.state,
    });
    await this.authority.recordExecutionAuthority(runId, {
      authority: computation.executionAuthority,
      backendId: computation.execution.isolation,
      backendIdentityHash: sha256(canonicalJson({ backendId: computation.execution.isolation })),
    });
    await this.commitCanonicalAndMirror(next);
    const outcome = workspaceGateOutcome(computation.evaluation, workspace.state.activePhase);
    if (!isGlobal && !outcome.activePhasePassed) {
      // Failed gates automatically feed stagnation diagnosis (same rule as development).
      const failingCodes = (computation.evaluation.phaseGates[workspace.state.activePhase]?.rows ?? []).filter((row) => !row.passed).map((row) => row.code).sort();
      await this.authority.applyBuilderTransition(runId, {
        kind: "record-attempt",
        action: `gate:${workspace.state.activePhase}`,
        evidenceHash: sha256(canonicalJson({ phase: workspace.state.activePhase, failingCodes })),
        score: computation.evaluation.phaseGates[workspace.state.activePhase]?.score ?? 0,
      }, this.context(_capability ?? "builder"));
    }
    const final = await this.authority.readRun(runId);
    await this.commitCanonicalAndMirror(final);
    if (!isGlobal) {
      const activeReport = computation.evaluation.phaseGates[workspace.state.activePhase];
      return {
        profile: computation.evaluation.deterministic.profile,
        activePhase: workspace.state.activePhase,
        passed: outcome.activePhasePassed,
        score: activeReport?.score,
        workorders: activeReport?.workorders,
        oracleHash: computation.evaluation.oracleHash,
        candidateHash: computation.evaluation.candidateHash,
        note: "active-phase only; use global:true for whole-object diagnostics",
      };
    }
    return { ...outcome, candidateHash: computation.evaluation.candidateHash, executionAuthority: computation.executionAuthority };
  }

  async lock(runId: string, phaseInput?: string, capability: Capability = "builder"): Promise<Record<string, unknown>> {
    const record = await this.loadRecord(runId);
    const workspace = await this.loadRunWorkspace(record);
    await this.assertBindingsCurrent(record, workspace);
    const state = record.embedded.state;
    const phase = phaseInput ?? state.activePhase;
    // B4: lock selects the CURRENT passing authoritative evidence generated by trusted gates.
    if (phase === "oracle-registration" && record.policy.profile === "tank") {
      const preparation = await verifyWorkspaceOraclePreparation(workspace);
      await verifyLatestOracleSanity(workspace.layout.internal.captures, preparation.binding.preparedHash);
    }
    const geometryHash = phase === "oracle-registration" ? state.oracleHash : state.phaseGeometryHashes[phase];
    if (!geometryHash) throw new PipelineError("NOTHING_TO_LOCK", `no measured geometry is available for phase ${phase}; run gate first`);
    const hasPassingEvidence = Object.values(state.evidence).some((item) => item.phase === phase && item.valid && item.verified && item.passed && isAuthoritativeEvidence(item));
    if (!hasPassingEvidence && phase !== "oracle-registration") throw new PipelineError("NOTHING_TO_LOCK", `phase ${phase} has no passing authoritative gate evidence produced by this trusted run`);
    const next = await this.authority.applyBuilderTransition(runId, { kind: "lock-phase", phase }, this.context(capability));
    await this.commitCanonicalAndMirror(next);
    return { status: "locked", activePhase: next.embedded.state.activePhase, locks: Object.keys(next.embedded.state.locks) };
  }

  async reopen(runId: string, input: { phase: string; reason: string }, capability: Capability): Promise<Record<string, unknown>> {
    const next = await this.authority.applyBuilderTransition(runId, { kind: "reopen-phase", phase: input.phase, reason: input.reason }, this.context(capability));
    await this.commitCanonicalAndMirror(next);
    return { status: "reopened", activePhase: next.embedded.state.activePhase };
  }

  // ---------------------------------------------------------------- replay/review/finalize

  /**
   * Internal trusted GLOBAL replay (closure plan §8.E1): recomputes the CURRENT candidate
   * with the installed evaluator under the CURRENT oracle preparation, requires every
   * builder phase to pass, computes its own identities, records the compact replay record
   * internally, and returns the LIVE execution bundle to its immediate caller.
   */
  async trustedReplay(runId: string): Promise<TrustedReplayBundle> {
    const record = await this.loadRecord(runId);
    const workspace = await this.loadRunWorkspace(record);
    await this.assertBindingsCurrent(record, workspace);
    const preparation = await verifyWorkspaceOraclePreparation(workspace);
    if (preparation.binding.identity !== record.oraclePreparationIdentity) {
      throw new PipelineError("PREPARATION_DRIFT", "live oracle preparation differs from the canonical binding; rerun onboard/register");
    }
    const state = record.embedded.state;
    const unlocked = Object.entries(state.phaseStatus).filter(([phase, status]) => phase !== "final" && phase !== "visual-review" && status !== "passed" && status !== "skipped").map(([phase]) => phase);
    if (unlocked.length) throw new PipelineError("PHASES_UNLOCKED", `global replay requires all builder phases locked: ${unlocked.join(", ")}`);
    if (state.authorshipMode === "derived") {
      await verifyDerivedLineage({
        modelEntryPath: workspace.resolved.model,
        workspaceRoot: workspace.root,
        profile: workspace.project.profile,
        authorshipMode: "derived",
        derivedBindings: state.derivedBindings,
        trustedModules: await loadTrustedGeneratedModules({
          directory: derivedDirectory(workspace.layout.internal.root),
          workspaceRoot: workspace.root,
          preparationIdentity: preparation.binding.identity,
          bindings: state.derivedBindings,
          allowedPhases: new Set(getProfileContract(workspace.project.profile).phases.filter((item) => item.owner === "builder").map((item) => item.id)),
        }),
      });
    }
    const computation = await computeWorkspaceGate(workspace, {
      isGlobal: true,
      toolchainId: record.toolchain.toolchainId,
      projectPolicyHash: record.projectPolicyHash,
      artifactRunId: `replay-${record.runId}-${record.mirrorSequence + 1}`,
      trusted: true,
      ...(this.executionScratchRoot ? { executionScratchRoot: this.executionScratchRoot } : {}),
    });
    if (!computation.evaluation.passed) {
      throw new PipelineError("REPLAY_FAILED", "fresh global replay failed; certification refuses until every gate passes");
    }
    // Content-deterministic replay hash: identical evaluated facts produce an identical
    // replay, so finalize's fresh replay matches the approved one when nothing changed.
    const replayHash = sha256(canonicalJson({
      kind: "trusted-final-replay",
      candidateHash: computation.evaluation.candidateHash,
      oraclePreparationIdentity: record.oraclePreparationIdentity,
      evaluationIdentityHash: computation.evaluationIdentityHash,
      globalPassed: true,
    }));
    const executionAuthority = computation.executionAuthority;
    await this.authority.recordExecutionAuthority(runId, {
      authority: executionAuthority,
      backendId: computation.execution.isolation,
      backendIdentityHash: sha256(canonicalJson({ backendId: computation.execution.isolation })),
    });
    // Persist the GLOBAL gate evidence (whole-object rows incl. final-phase gates) into
    // canonical state so certification recomputation sees the replay's authoritative gates.
    const replayTag = `replay-${record.runId}-${record.mirrorSequence + 1}`;
    const replayDirectory = join(workspace.layout.internal.evidence, replayTag);
    await mkdir(replayDirectory, { recursive: true });
    const replayArtifacts: EvidenceArtifact[] = [];
    for (const item of computation.artifacts) {
      await writeFile(join(replayDirectory, `${item.suggestedId}.json`), `${JSON.stringify(item.artifact, null, 2)}\n`, { flag: "wx" });
      replayArtifacts.push(item.artifact);
    }
    const { applyGateEvidence } = await import("../operations/workspace-gate.js");
    const replayState = applyGateEvidence(record.embedded.state, computation, (state, artifact) => recordEvidenceArtifact(state, `.mesh2threejs/evidence/${replayTag}/${artifact.id}.json`, artifact), computation.evaluationIdentity);
    await this.authority.recordComputedGate(runId, {
      phase: null,
      passed: true,
      evaluationIdentityHash: computation.evaluationIdentityHash,
      artifacts: replayArtifacts,
      stateAfter: replayState,
    });
    const next = await this.authority.recordComputedReplay(runId, {
      replayHash,
      passed: true,
      evaluationIdentityHash: computation.evaluationIdentityHash,
      candidateHash: computation.evaluation.candidateHash,
      oraclePreparationIdentity: record.oraclePreparationIdentity!,
      evaluatedAt: new Date().toISOString(),
    });
    await this.commitCanonicalAndMirror(next);
    return {
      replayHash,
      candidateHash: computation.evaluation.candidateHash,
      evaluationIdentityHash: computation.evaluationIdentityHash,
      executionAuthority: computation.executionAuthority,
      neutralSceneHash: computation.execution.neutralSceneHash,
      neutralSerialization: computation.execution.serialization,
      neutralRoot: computation.execution.neutralRoot,
      posedRoots: computation.execution.posedRoots.map((sample) => ({ pose: sample.pose, root: sample.root })),
    };
  }

  /**
   * Trusted review-ready (closure plan §9.F1, remaining closure §3): fresh replay -> full
   * capture set rendered from the SAME replay execution -> exact viewer scene emitted from
   * the same neutral serialization -> complete canonical review binding. No second
   * candidate execution exists in this flow. Reports user-facing paths; NEVER starts the
   * viewer (F5).
   */
  async reviewReady(runId: string): Promise<Record<string, unknown>> {
    const record = await this.loadRecord(runId);
    const workspace = await this.loadRunWorkspace(record);
    await this.assertBindingsCurrent(record, workspace);
    const replay = await this.trustedReplay(runId);
    const fresh = await this.authority.readRun(runId);
    const manifest = await verifyWorkspaceOraclePreparation(workspace);
    const oracle = await loadPreparedOracle(manifest.manifest, workspace.root);
    const renderRunDirectory = join(workspace.layout.internal.captures, `render-review-${record.mirrorSequence + 1}`);
    await mkdir(renderRunDirectory, { recursive: true });
    const sceneArtifactPath = join(renderRunDirectory, "viewer-scene.json");
    const sceneBytes = `${JSON.stringify({ schemaVersion: 1, candidateHash: replay.candidateHash, sceneHash: replay.neutralSceneHash, serialization: replay.neutralSerialization }, null, 2)}\n`;
    await writeFile(sceneArtifactPath, sceneBytes, { flag: "wx" });
    const sceneSha = sha256(Buffer.from(sceneBytes, "utf8"));
    const result = await performRenderRun({
      workspace,
      manifest: manifest.manifest,
      candidateIdentity: { candidateHash: replay.candidateHash },
      candidate: replay.neutralRoot,
      oracle,
      directory: renderRunDirectory,
      runId: basename(renderRunDirectory),
    });
    const renderManifest = JSON.parse(await readFile(join(renderRunDirectory, "render-manifest.json"), "utf8")) as {
      captures: Array<{ path: string; sha256: string; pass: string; cameraId: string }>;
      comparisonBoards: Array<{ path: string; sha256: string }>;
      turntable: Array<{ path: string; sha256: string }>;
      regionDiagnostics?: { path: string; sha256: string };
    };
    // Deterministic/style/articulation artifacts referenced by the packet come from the
    // trusted evidence recorded by THIS run's gates/replay.
    const state = fresh.embedded.state;
    const deterministic = Object.values(state.evidence).filter((item) => item.valid && item.verified && item.passed && isAuthoritativeEvidence(item) && item.kind === "deterministic-gate");
    const style = Object.values(state.evidence).filter((item) => item.kind === "style" && item.valid).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const articulation = Object.values(state.evidence).filter((item) => item.kind === "articulation" && item.valid).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!deterministic.length || !style) throw new PipelineError("REVIEW_EVIDENCE_INCOMPLETE", "current passing deterministic/style evidence is incomplete; run gate first");
    const readWorkspaceFile = async (path: string): Promise<Buffer> => readFile(this.resolveWorkspace(path, workspace), );
    const fileRef = async (path: string, role: ReviewFileReference["role"], knownHash?: string): Promise<ReviewFileReference> => ({
      path,
      role,
      sha256: knownHash ?? sha256(await readWorkspaceFile(path)),
    });
    const deterministicIndexPath = join(renderRunDirectory, "deterministic-evidence.json");
    await writeFile(deterministicIndexPath, `${JSON.stringify({ schemaVersion: 1, evidence: deterministic.map((item) => ({ id: item.id, path: item.artifact, artifactHash: item.artifactHash })) })}\n`, { flag: "wx" });
    const deterministicFile = await fileRef(this.toProjectPath(deterministicIndexPath, workspace), "deterministic");
    const styleFile = await fileRef(style.artifact, "style");
    const articulationFile = articulation ? await fileRef(articulation.artifact, "articulation") : undefined;
    const captureFiles = renderManifest.captures.map((item) => ({ path: item.path, sha256: item.sha256, role: "capture" as const }));
    const boardFiles = renderManifest.comparisonBoards.map((item) => ({ path: item.path, sha256: item.sha256, role: "comparison-board" as const }));
    const turntableFiles = renderManifest.turntable.map((item) => ({ path: item.path, sha256: item.sha256, role: "turntable" as const }));
    const regionFile = renderManifest.regionDiagnostics ? { ...renderManifest.regionDiagnostics, role: "region" as const } : undefined;
    const packet = createVisualReviewPacket({
      oracleHash: manifest.binding.identity,
      candidateHash: replay.candidateHash,
      profile: workspace.project.profile,
      profileContractHash: state.profileContractHash,
      styleContractHash: state.styleContractHash,
      evaluationIdentityHash: state.evaluationIdentityHash!,
      styleHash: styleFile.sha256,
      deterministicArtifactHash: deterministicFile.sha256,
      captures: renderManifest.captures.map(({ path, sha256: hash, pass, cameraId }) => ({ path, sha256: hash, pass, cameraId })),
      comparisonBoardHashes: boardFiles.map((item) => item.sha256),
      turntableHashes: turntableFiles.map((item) => item.sha256),
      ...(articulationFile ? { articulationArtifactHash: articulationFile.sha256 } : {}),
      regionEvidence: regionFile ? { status: "available", semanticArtifactHash: regionFile.sha256 } : { status: "unavailable", reason: "this render run did not emit semantic region diagnostics" },
      files: [...captureFiles, ...boardFiles, ...turntableFiles, deterministicFile, styleFile, ...(articulationFile ? [articulationFile] : []), ...(regionFile ? [regionFile] : [])],
    });
    const packetPath = join(renderRunDirectory, "packet.json");
    await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, { flag: "wx" });
    await verifyVisualReviewPacketFiles(packet, workspace.root);
    const binding: ReviewBinding = {
      packetHash: packet.packetHash,
      packetFile: { path: this.toProjectPath(packetPath, workspace), sha256: sha256(Buffer.from(`${JSON.stringify(packet, null, 2)}\n`, "utf8")) },
      replayHash: replay.replayHash,
      candidateHash: replay.candidateHash,
      oraclePreparationIdentity: manifest.binding.identity,
      evaluationIdentityHash: state.evaluationIdentityHash,
      toolchainId: record.toolchain.toolchainId,
      scene: { path: this.toProjectPath(sceneArtifactPath, workspace), sha256: sceneSha, sceneHash: replay.neutralSceneHash },
      captures: [
        ...captureFiles.map((item) => ({ path: item.path, sha256: item.sha256, role: "capture" })),
        ...boardFiles.map((item) => ({ path: item.path, sha256: item.sha256, role: "comparison-board" })),
        ...turntableFiles.map((item) => ({ path: item.path, sha256: item.sha256, role: "turntable" })),
        // Deterministic index, style/articulation artifacts and region diagnostics join the
        // exact-bytes review binding so approval re-verifies everything the human can see.
        { path: deterministicFile.path, sha256: deterministicFile.sha256, role: "deterministic-index" },
        { path: styleFile.path, sha256: styleFile.sha256, role: "style-artifact" },
        ...(articulationFile ? [{ path: articulationFile.path, sha256: articulationFile.sha256, role: "articulation-artifact" }] : []),
        ...(regionFile ? [{ path: regionFile.path, sha256: regionFile.sha256, role: "region-diagnostic" }] : []),
      ],
      humanApproval: null,
    };
    const bound = await this.authority.recordComputedReviewPacket(runId, binding);
    // Turntable capture evidence joins canonical state bound to the exact reviewed packet.
    const { bindEvidenceConfig, createRenderEvidenceArtifact } = await import("../core/state.js");
    let reviewState = bound.embedded.state;
    reviewState = bindEvidenceConfig(reviewState, "turntable", packet.packetHash, "review capture set regenerated");
    reviewState = bindEvidenceConfig(reviewState, "visual-review", packet.packetHash, "review capture set regenerated");
    const turntableArtifact = createRenderEvidenceArtifact({
      id: `${basename(renderRunDirectory)}-turntable`,
      phase: "visual-review",
      oracleHash: manifest.binding.identity ? fingerprintScene(oracle) : fingerprintScene(oracle),
      candidateHash: replay.candidateHash,
      profileContractHash: state.profileContractHash,
      styleContractHash: state.styleContractHash,
      evaluationIdentityHash: state.evaluationIdentityHash!,
      configHash: packet.packetHash,
      manifest: { turntable: renderManifest.turntable },
    });
    const turntablePath = join(renderRunDirectory, "turntable-evidence.json");
    await writeFile(turntablePath, `${JSON.stringify(turntableArtifact, null, 2)}\n`, { flag: "wx" });
    reviewState = recordEvidenceArtifact(reviewState, this.toProjectPath(turntablePath, workspace), turntableArtifact);
    const withTurntable = await this.authority.recordComputedGate(runId, {
      phase: "visual-review",
      passed: true,
      evaluationIdentityHash: state.evaluationIdentityHash!,
      artifacts: [turntableArtifact],
      stateAfter: reviewState,
    });
    await this.commitCanonicalAndMirror(withTurntable);
    return {
      status: "ready-for-user-review",
      candidateHash: replay.candidateHash,
      packet: { hash: packet.packetHash, path: this.toProjectPath(packetPath, workspace) },
      capture: {
        directory: this.toProjectPath(renderRunDirectory, workspace),
        boards: result.comparisonBoards.map((board) => this.toProjectPath(board.path, workspace)),
        turntable: `${this.toProjectPath(renderRunDirectory, workspace)}/turntable/`,
        viewerScene: this.toProjectPath(sceneArtifactPath, workspace),
      },
      viewerStatus: "not-started",
      note: "final human visual approval is required; the interactive viewer is optional and starts only with explicit user approval",
    };
  }

  private resolveWorkspace(path: string, workspace: ResumedWorkspace): string {
    return /^([a-zA-Z]:)?[/\\]/u.test(path) ? path : resolve(workspace.root, path);
  }

  private toProjectPath(path: string, workspace: ResumedWorkspace): string {
    try {
      return workspace.layout ? createWorkspaceResolver(workspace.root).toProjectPath(path) : path;
    } catch {
      return path;
    }
  }

  /** Human/admin approval sealed from canonical values only (§9.F3). */
  async approveReview(runId: string, input: { method?: "broker-console" | "host-capability" | "test-capability" }, capability: Capability): Promise<Record<string, unknown>> {
    const next = await this.authority.approveReview(runId, { method: input.method ?? "broker-console" }, this.context(capability));
    await this.commitCanonicalAndMirror(next);
    return { status: "approved", approvedAt: next.review.humanApproval?.approvedAt };
  }

  async approveViewerStart(runId: string, capability: Capability): Promise<Record<string, unknown>> {
    const next = await this.authority.applyBuilderTransition(runId, { kind: "set-viewer-approved" }, this.context(capability));
    await this.commitCanonicalAndMirror(next);
    return { status: "viewer-approved" };
  }

  /**
   * Trusted finalize (closure plan §8.E2): ALWAYS executes a fresh global replay, then
   * certifies only when the current approval binds that exact replay and packet.
   */
  async finalize(runId: string, capability: Capability): Promise<Record<string, unknown>> {
    const toolchain = await this.toolchain();
    if (!toolchain.trustedToolchain) {
      throw new PipelineError("TRUSTED_TOOLCHAIN_UNAVAILABLE", "this installation cannot anchor trusted toolchain identity (development checkout); certification refuses");
    }
    // Finalization precondition (remaining closure §5.3): the files the human approved must
    // still be byte-identical before any fresh replay/certification.
    const preReplay = await this.authority.readRun(runId);
    try {
      const { verifyBoundReviewArtifacts } = await import("../core/run-authority.js");
      await verifyBoundReviewArtifacts(preReplay);
    } catch (error) {
      throw new PipelineError("REVIEW_ARTIFACT_DRIFT", error instanceof Error ? error.message : String(error));
    }
    const freshReplay = await this.trustedReplay(runId);
    const record = await this.authority.readRun(runId);
    const approval = record.review.humanApproval;
    if (!approval) {
      throw new PipelineError("REVIEW_REAPPROVAL_REQUIRED", "no human approval is bound; review-ready and human approval are required before certification");
    }
    if (approval.trustedReplayHash !== freshReplay.replayHash || approval.packetHash !== record.review.packetHash) {
      throw new PipelineError("REVIEW_REAPPROVAL_REQUIRED", "the fresh replay differs from the approved review binding; re-approval by the human operator is required");
    }
    const certified = await this.authority.certify(runId, this.context(capability));
    await this.commitCanonicalAndMirror(certified);
    return { status: "certified", runId };
  }

  /** Authority-bound viewer scene resolution for the viewer server (§9.F4). */
  async viewerSceneBinding(runId: string): Promise<{ path: string; sha256: string; sceneHash: string }> {
    const record = await this.authority.readRun(runId);
    if (!record.review.scene) throw new PipelineError("REVIEW_SCENE_MISSING", "no trusted review scene is bound to this run; run review-ready first");
    return record.review.scene;
  }

  /**
   * Human/admin viewer launch (§9.F5): requires prior operator approval AND a bound review
   * scene. The daemon serves only the authority-bound bytes — never a workspace scan.
   */
  async viewerStart(runId: string, capability: Capability): Promise<Record<string, unknown>> {
    assertCapability("viewer-start", capability);
    const record = await this.authority.readRun(runId);
    if (!record.viewerStartApproved) throw new PipelineError("VIEWER_APPROVAL_REQUIRED", "viewer start for a trusted run requires explicit user approval first (approve-viewer-start)");
    const scene = await this.viewerSceneBinding(runId);
    const { startViewer } = await import("../viewer/manager.js");
    const result = await startViewer(record.workspaceRoot, { trustedScene: { path: resolve(record.workspaceRoot, scene.path), sha256: scene.sha256 } });
    return { status: result.status, url: result.url };
  }

  /** Detects workspace mirror drift without mutating anything (diagnostics). */
  async detectDrift(runId: string): Promise<string | null> {
    const record = await this.authority.readRun(runId);
    try {
      const statePath = join(record.workspaceRoot, ".mesh2threejs", "state.json");
      const raw = JSON.parse(await readFile(statePath, "utf8")) as { mirrorOfRun?: Parameters<typeof detectWorkspaceStateDrift>[0] };
      return detectWorkspaceStateDrift(raw.mirrorOfRun, record);
    } catch {
      return "workspace mirror is unreadable";
    }
  }
}

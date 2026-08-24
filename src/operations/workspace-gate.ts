import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import * as THREE from "three";
import type { ResumedWorkspace } from "../core/workspace.js";
import { createWorkspaceResolver } from "../core/workspace.js";
import { auditCandidateModule } from "../core/candidate.js";
import { composeCandidateHash } from "../core/candidate.js";
import { fingerprintScene, sha256, canonicalJson } from "../core/hashing.js";
import { serializeScene, serializedSceneHash } from "../core/scene-serialization.js";
import type { SandboxBackend } from "../core/candidate-sandbox.js";
import { trustedDerivedBackend } from "../core/candidate-sandbox.js";
import type { CandidateExecutionAuthority, DerivedGraphExpectations } from "../core/exec-authority.js";
import { phaseSemanticScope } from "../core/phase-compose.js";
import { snapshotScene } from "../core/geometry.js";
import {
  bindCandidatePhases,
  bindEvidenceConfig,
  bindOracle,
  recordEvidenceArtifact,
  createRuntimeGateEvidenceArtifact,
  createRuntimeEvaluationEvidenceArtifact,
  type EvidenceArtifact,
  type TaskState,
} from "../core/state.js";
import { neutralPoseForProfile, requiredPosesForProfile, evaluateCandidateFromSamples, type PosedEvaluationBundle } from "../core/orchestration.js";
import { loadPreparedOracle, oraclePreparationIdentity } from "../core/oracle.js";
import type { OracleManifest } from "../core/oracle.js";
import { getProfileContract, profileContractHash } from "../core/contracts.js";
import { createEvaluationIdentity, EVALUATOR_VERSION, evaluationIdentityHash, MEASUREMENT_VERSION, optionalContractHash } from "../core/identity.js";
import { trustedGeneratedAuditOptions } from "../core/derive.js";
import { loadStyleContract } from "../styles/low-poly.js";
import type { GenericSubjectContract } from "../profiles/generic.js";
import type { ProfileId } from "../types.js";

/**
 * Shared workspace-operation implementations (closure plan §5.B1): the development CLI and
 * the trusted pipeline invoke THESE functions, so there is exactly one evaluator path and
 * no divergence between development diagnostics and authoritative reconstruction.
 */

export interface WorkspaceExecutionInspection {
  candidateHash: string;
  sourceHash: string;
  neutralSceneHash: string;
  candidateFiles: Array<{ path: string; sha256: string }>;
  neutralRoot: THREE.Object3D;
  posedRoots: Array<{ pose: Record<string, number>; root: THREE.Object3D }>;
  serialization: ReturnType<typeof serializeScene>;
  sceneHash: string;
  isolation: import("../core/candidate-sandbox.js").CandidateIsolation;
  deterministic: boolean;
}

/**
 * Backend resolution for a trusted operation (remaining closure §2.6/§2.7): an explicit
 * backend is honored only when it is NOT the development in-process loader; otherwise the
 * bounded child process executes the proven graph outside this process. There is never a
 * silent in-process fallback inside a trusted run.
 */
function resolveTrustedBackend(backend?: SandboxBackend): SandboxBackend {
  if (backend && backend.name !== "in-process") return backend;
  if (backend && backend.name === "in-process") throw new Error("TRUSTED_IN_PROCESS_EXECUTION_REFUSED: trusted operations never execute candidates inside the calling process");
  return trustedDerivedBackend();
}

/**
 * The one authoritative workspace-candidate inspection path: audit -> byte-verified
 * authority establishment -> sandbox execution -> trusted reconstruction. No live untrusted
 * runtime object is produced.
 */
export async function inspectWorkspaceCandidateViaExecutor(input: {
  workspaceRoot?: string;
  modelEntryPath: string;
  boundaryRoot?: string;
  poses: Array<Record<string, number>>;
  auditOptions?: Parameters<typeof auditCandidateModule>[1];
  backend?: SandboxBackend;
  /** Trusted-run execution route: refuses in-process backends and defaults to the bounded child. */
  trusted?: boolean;
  /** Derived byte expectations; required for trusted derived runs, computed by trusted code. */
  authorityExpectations?: DerivedGraphExpectations;
}): Promise<WorkspaceExecutionInspection & { auditFiles: ReadonlyArray<string>; trustedGeneratedModules: ReadonlyArray<string>; graphAuthority: import("../core/exec-authority.js").ExecutableGraphAuthority }> {
  const { executeWorkspaceModel, deserializeExecutionSamples } = await import("../core/composition-exec.js");
  const result = await executeWorkspaceModel({
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
    modelEntryPath: input.modelEntryPath,
    boundaryRoot: input.boundaryRoot ?? dirname(input.modelEntryPath),
    poses: input.poses,
    auditOptions: input.auditOptions,
    backend: input.trusted ? resolveTrustedBackend(input.backend) : input.backend ?? (await import("../core/dev-sandbox.js")).developmentInProcessBackend(),
    ...(input.authorityExpectations ? { authorityExpectations: input.authorityExpectations } : {}),
  });
  const samples = deserializeExecutionSamples(result);
  const neutralSerialization = result.samples[0]!.serialization;
  const neutralSceneHash = fingerprintScene(samples.neutralRoot);
  return {
    candidateHash: composeCandidateHash(neutralSceneHash, result.sourceHash),
    sourceHash: result.sourceHash,
    neutralSceneHash,
    candidateFiles: result.audit.candidateFiles.map((file) => ({ ...file })),
    neutralRoot: samples.neutralRoot,
    posedRoots: samples.posedRoots,
    serialization: neutralSerialization,
    sceneHash: serializedSceneHash(neutralSerialization),
    isolation: result.isolation,
    deterministic: result.deterministic,
    auditFiles: [...result.audit.files],
    trustedGeneratedModules: [...result.audit.trustedGeneratedModules],
    graphAuthority: result.graphAuthority,
  };
}

/**
 * Cumulative active-phase semantic scope from the single authoritative ownership model:
 * a phase may carry its own semantics plus everything prerequisite phases legitimately
 * contributed. Future-phase geometry is refused before any gate runs.
 */
export function assertPhaseSemanticScope(profile: ProfileId, activePhase: string | undefined, root: THREE.Object3D): void {
  if (!activePhase) return;
  const allows = phaseSemanticScope(profile, activePhase);
  if (!allows) return; // profile without an ownership model imposes no mechanical restriction.
  const snapshot = snapshotScene(root);
  const violations = Object.entries(snapshot.components)
    .filter(([id, component]) => !allows(id, component.role))
    .map(([id]) => id);
  if (violations.length) throw new Error(`phase-scope violation: active phase ${activePhase} does not permit future-phase semantics ${violations.join(", ")}; remove the placeholder or advance to that phase first`);
}

export function workspaceGateOutcome(evaluation: Pick<PosedEvaluationBundle, "passed" | "phaseGates">, activePhase: string): { activePhase: string; activePhasePassed: boolean; globalPassed: boolean } {
  return { activePhase, activePhasePassed: evaluation.phaseGates[activePhase]?.passed ?? false, globalPassed: evaluation.passed };
}

export interface GateComputation {
  execution: Awaited<ReturnType<typeof inspectWorkspaceCandidateViaExecutor>>;
  executionAuthority: CandidateExecutionAuthority;
  evaluation: PosedEvaluationBundle;
  evaluationIdentity: ReturnType<typeof createEvaluationIdentity>;
  evaluationIdentityHash: string;
  configHash: string;
  recordsStyle: boolean;
  /** Evidence artifacts computed by this gate run (recording is the caller's authority concern). */
  artifacts: Array<{ artifact: EvidenceArtifact; suggestedId: string }>;
}

/**
 * Computes one whole-object (--global) or active-phase gate over a live workspace through
 * the single trusted execution path. Performs NO state mutation and NO persistence — the
 * caller decides where evidence lands (development state file vs canonical run authority).
 * With `trusted: true` the candidate executes in the bounded child backend and, for derived
 * runs, only after its exact bytes match the canonical scaffold/registry/generated bindings.
 */
export async function computeWorkspaceGate(workspace: ResumedWorkspace, options: {
  isGlobal?: boolean;
  backend?: SandboxBackend;
  /** Trusted-run identity fields; development callers pass null. */
  toolchainId?: string | null;
  projectPolicyHash?: string | null;
  /** Prefix for evidence artifact ids (unique per gate run). */
  artifactRunId: string;
  /** Trusted execution route (§2.7): never in-process; byte-verified derived authority. */
  trusted?: boolean;
}): Promise<GateComputation> {
  const { verifyWorkspaceOraclePreparation } = await import("../core/workspace.js");
  const preparation = await verifyWorkspaceOraclePreparation(workspace);
  const manifest: OracleManifest = preparation.manifest;
  const preparationIdentity = preparation.binding.identity;
  const profile = workspace.project.profile;
  const subjectContractPath = workspace.resolved.subjectContract ? await readFile(resolve(workspace.resolved.subjectContract), 'utf8') : undefined;
  const subjectContract = subjectContractPath ? (JSON.parse(subjectContractPath) as GenericSubjectContract) : undefined;
  const isGlobal = options.isGlobal ?? false;
  const activePhase = workspace.state.activePhase;
  const profileContract = getProfileContract(profile);
  // Phase isolation at identity time: a partial candidate without physical controls is
  // inspected without applying articulation controls unless this gate evaluates that phase.
  const needsArticulation = !activePhase || isGlobal || profileContract.gates.some((gate) => gate.code === "articulation.poses" && gate.phase === activePhase);
  const poses = needsArticulation ? requiredPosesForProfile(profile, subjectContract) : [neutralPoseForProfile(profile, subjectContract)];
  const auditOptions = await trustedGeneratedAuditOptions(workspace, preparationIdentity);
  // Trusted derived runs pin the exact expected graph bytes BEFORE execution (§2.2–§2.3):
  // scaffold scaffold bytes plus a registry regenerated from the currently bound phases.
  let authorityExpectations: DerivedGraphExpectations | undefined;
  if (options.trusted && workspace.state.authorshipMode === "derived") {
    const { MODEL_DERIVED_SCAFFOLD, GENERATED_REGISTRY_PATH, generateRegistrySource, orderedDerivedPhasesFromBindings } = await import("../core/derivation.js");
    authorityExpectations = {
      scaffoldSource: MODEL_DERIVED_SCAFFOLD,
      registryPath: resolve(workspace.root, GENERATED_REGISTRY_PATH),
      registrySource: generateRegistrySource(workspace.project.profile, orderedDerivedPhasesFromBindings(workspace.project.profile, workspace.state.derivedBindings)),
    };
  }
  const execution = await inspectWorkspaceCandidateViaExecutor({
    workspaceRoot: workspace.root,
    boundaryRoot: resolve(workspace.root, "model"),
    modelEntryPath: workspace.resolved.model,
    poses,
    auditOptions,
    ...(options.trusted ? { trusted: true } : {}),
    ...(authorityExpectations ? { authorityExpectations } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
  });
  if (!isGlobal) assertPhaseSemanticScope(profile, activePhase, execution.neutralRoot);
  const executionAuthority = execution.graphAuthority.authority;
  if (!execution.deterministic) throw new Error("candidate execution was not deterministic across repeated runs; refusing to gate");
  const certification = workspace.state.certification;
  const oraclePreparationHash = preparationIdentity ?? oraclePreparationIdentity(manifest as never);
  const evaluationIdentity = createEvaluationIdentity({
    evaluatorVersion: EVALUATOR_VERSION,
    measurementVersion: MEASUREMENT_VERSION,
    profile,
    profileContractHash: workspace.state.profileContractHash || profileContractHash(getProfileContract(profile)),
    styleContractHash: workspace.styleContractHash,
    subjectContractHash: optionalContractHash(subjectContract),
    certification,
    oraclePreparationHash,
    preparedOracleHash: (manifest as unknown as { preparedHash: string }).preparedHash,
    authoritativeDimensionsHash: optionalContractHash((manifest as unknown as { authoritativeDimensions?: Record<string, number> }).authoritativeDimensions),
    candidateSourceHash: execution.sourceHash,
    candidateNeutralHash: execution.neutralSceneHash,
    toolchainId: options.toolchainId ?? null,
    projectPolicyHash: options.projectPolicyHash ?? null,
    candidateIsolation: executionAuthority === "trusted-host-sandbox" ? "trusted-host-sandbox" : executionAuthority === "trusted-derived-generated" ? "trusted-derived-generated" : "development-untrusted",
  });
  const currentEvaluationHash = evaluationIdentityHash(evaluationIdentity);
  const oracle = await loadPreparedOracle(manifest as never, workspace.root);
  const evaluation = await evaluateCandidateFromSamples({
    oracle,
    candidateSamples: [
      { pose: poses[0]!, root: execution.neutralRoot },
      ...execution.posedRoots.map((sample) => ({ pose: sample.pose, root: sample.root })),
    ],
    profile,
    candidateNeutralHash: execution.neutralSceneHash,
    candidateSourceHash: execution.sourceHash,
    style: workspace.styleContract,
    certification,
    ...(subjectContract ? { subjectContract } : {}),
    ...(manifest.authoritativeDimensions ? { authoritativeDimensions: manifest.authoritativeDimensions } : {}),
    ...(isGlobal || !activePhase ? {} : { phase: activePhase }),
  });
  const configHash = currentEvaluationHash;
  const recordsStyle = !activePhase || isGlobal || activePhase === (profile === "tank" ? "style-fabrication" : "style-complexity");
  const complexityRows = evaluation.style.rows.filter((row) => row.code.startsWith("style.complexity"));
  const complexityReport = { profile, passed: complexityRows.every((row) => row.passed), score: complexityRows.length ? Math.min(...complexityRows.map((row) => row.score)) : 0, rows: complexityRows, workorders: evaluation.style.workorders.filter((item) => item.errorKind.startsWith("style.complexity")) };
  const runId = options.artifactRunId;
  const artifactInputs = [
    ...Object.entries(evaluation.phaseGates).map(([phase, report]) => ({ id: `${runId}-${phase}`, kind: "gate" as const, phase, report })),
    ...(recordsStyle ? [
      { id: `${runId}-style`, kind: "style" as const, phase: profile === "tank" ? "style-fabrication" : "style-complexity", report: evaluation.style },
      { id: `${runId}-complexity`, kind: "complexity" as const, phase: profile === "tank" ? "style-fabrication" : "style-complexity", report: complexityReport },
    ] : []),
    ...(evaluation.articulation.rows.length ? [{ id: `${runId}-articulation`, kind: "articulation" as const, phase: evaluation.articulation.rows[0]!.phase ?? (profile === "tank" ? "fittings-articulation" : "attachments"), report: evaluation.articulation }] : []),
  ];
  const artifacts = artifactInputs.map(({ id, kind, phase, report }) => ({
    suggestedId: id,
    artifact: kind === "gate"
      ? createRuntimeGateEvidenceArtifact({ id, phase, oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: workspace.state.profileContractHash, styleContractHash: workspace.state.styleContractHash, evaluationIdentityHash: currentEvaluationHash, configHash, report: report as never })
      : createRuntimeEvaluationEvidenceArtifact({ id, kind, phase, oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: workspace.state.profileContractHash, styleContractHash: workspace.state.styleContractHash, evaluationIdentityHash: currentEvaluationHash, configHash, report: report as never }),
  }));
  return {
    execution,
    executionAuthority,
    evaluation,
    evaluationIdentity,
    evaluationIdentityHash: currentEvaluationHash,
    configHash,
    recordsStyle,
    artifacts,
  };
}

/** Pure state mutation shared by the CLI and the trusted pipeline when applying a computed gate. */
export function applyGateEvidence(
  state: TaskState,
  computation: GateComputation,
  recordArtifact: (state: TaskState, artifact: EvidenceArtifact) => TaskState,
  evaluationIdentity?: Parameters<typeof bindCandidatePhases>[3],
): TaskState {
  let next = bindOracle(state, computation.evaluation.oracleHash);
  next = evaluationIdentity !== undefined
    ? bindCandidatePhases(next, computation.evaluation.candidateHash, computation.evaluation.phaseGeometryHashes, evaluationIdentity)
    : bindCandidatePhases(next, computation.evaluation.candidateHash, computation.evaluation.phaseGeometryHashes);
  const kinds: Array<"deterministic-gate" | "style" | "complexity" | "articulation"> = ["deterministic-gate", ...(computation.recordsStyle ? ["style", "complexity"] as const : []), ...(computation.evaluation.articulation.rows.length ? ["articulation"] as const : [])];
  for (const kind of kinds) next = bindEvidenceConfig(next, kind, computation.configHash, "canonical evaluation identity changed");
  for (const { artifact } of computation.artifacts) next = recordArtifact(next, artifact);
  return next;
}

export { sha256, canonicalJson, basename, readFile, isAbsolute };

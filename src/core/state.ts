import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AuthorshipMode, CertificationLevel, GateReport, ProfileId } from "../types.js";
import type { Route } from "./routing.js";
import { canonicalJson, sha256 } from "./hashing.js";
import { getProfileContract, profileContractHash } from "./contracts.js";
import { verifyVisualReviewPacketFiles, type VisualReviewPacket } from "./review.js";
import { getStyleContract } from "../styles/low-poly.js";
import { evaluationIdentityHash, type EvaluationIdentity } from "./identity.js";
import type { OraclePreparationBinding } from "./oracle.js";

export type SourceStatus = "supports" | "does-not-support" | "not-retrieved" | "contradicted" | "superseded";
export const EVIDENCE_GENERATOR_VERSION = "1.0.0";

export interface StateFact {
  id: string;
  value: unknown;
  source: string;
  confidence: number;
  status: SourceStatus;
}

export interface EvidenceRecord {
  id: string;
  kind: "registration" | "deterministic-gate" | "style" | "complexity" | "articulation" | "visual-review" | "turntable";
  phase: string;
  artifact: string;
  passed: boolean;
  oracleHash: string;
  candidateHash: string | null;
  valid: boolean;
  createdAt: string;
  artifactHash?: string;
  profileContractHash?: string;
  configHash?: string;
  verified?: boolean;
  gateResults?: GateEvidenceResult[];
  authority?: EvidenceAuthority;
  generatorVersion?: string;
  styleContractHash?: string;
  evaluationIdentityHash?: string | null;
}

export type EvidenceAuthority = "declared" | "runtime-gate-evaluation" | "runtime-render-capture" | "oracle-registration" | "external-visual-review";

export interface GateEvidenceResult {
  code: string;
  passed: boolean;
  score: number;
}

export interface EvidenceArtifact {
  schemaVersion: 3;
  id: string;
  kind: EvidenceRecord["kind"];
  phase: string;
  oracleHash: string;
  candidateHash: string | null;
  profileContractHash: string;
  styleContractHash: string;
  evaluationIdentityHash: string | null;
  configHash: string;
  generator: { name: "mesh2threejs"; version: string };
  createdAt: string;
  result: { passed: boolean; summary: string; details?: unknown };
  gateResults?: GateEvidenceResult[];
  authority: EvidenceAuthority;
  artifactHash: string;
}

export interface PhaseLock {
  phase: string;
  geometryHash: string;
  evidence: Array<{ id: string; artifact: string; artifactHash: string }>;
  oracleHash: string;
  candidateHash: string;
  contractHash: string;
  acceptedAt: string;
}

export interface PhaseReopen {
  phase: string;
  reason: string;
  invalidated: string[];
  reopenedAt: string;
}

export interface AttemptRecord {
  action: string;
  evidenceHash: string;
  score: number;
  createdAt: string;
}

/** Binding of one trusted pipeline-generated module to the preparation it was derived from. */
export interface DerivedBinding {
  manifestHash: string;
  generatedModuleHash: string;
  oraclePreparationIdentity: string;
}

export interface TaskState {
  schemaVersion: 1;
  taskId: string;
  profile: ProfileId;
  style: string;
  certification: CertificationLevel;
  authoritativeDimensions: { status: "not-admitted" | "admitted"; sources: string[] };
  status: "active" | "certified" | "blocked";
  route: Route;
  oracleHash: string | null;
  candidateHash: string | null;
  oraclePreparation: OraclePreparationBinding | null;
  observedFacts: StateFact[];
  userDecisions: Array<{ id: string; value: unknown }>;
  systemDecisions: Array<{ id: string; value: unknown; reason: string }>;
  modelInferences: StateFact[];
  recommendations: Array<{ id: string; value: unknown; reason: string }>;
  unresolvedItems: Array<{ id: string; description: string; blocking: boolean }>;
  actions: Array<{ id: string; route: Route; description: string; createdAt: string }>;
  verificationResults: Array<{ id: string; passed: boolean; evidenceId: string }>;
  evidence: Record<string, EvidenceRecord>;
  attempts: AttemptRecord[];
  phaseStatus: Record<string, "pending" | "active" | "passed" | "skipped" | "invalidated">;
  profileContractHash: string;
  styleContractHash: string;
  projectConfigurationHash: string | null;
  subjectContractHash: string | null;
  articulationRequired: boolean;
  evaluationIdentity: EvaluationIdentity | null;
  evaluationIdentityHash: string | null;
  activePhase: string;
  locks: Record<string, PhaseLock>;
  reopens: PhaseReopen[];
  visualReviewStatus: "awaiting" | "passed" | "failed";
  evidenceConfigHashes: Partial<Record<EvidenceRecord["kind"], string>>;
  phaseGeometryHashes: Record<string, string>;
  authorshipMode: AuthorshipMode;
  /** Trusted generated modules recorded by the derive pipeline, keyed by generated module path. */
  derivedBindings: Record<string, DerivedBinding>;
}

function lifecycle(profile: ProfileId): { phases: string[]; dependencies: Record<string, string[]> } {
  const contract = getProfileContract(profile);
  return {
    phases: contract.phases.map((phase) => phase.id),
    dependencies: Object.fromEntries(contract.phases.map((phase) => [phase.id, phase.dependsOn])),
  };
}

function gateAuthority(owner: "oracle" | "builder" | "reviewer" | "finalizer"): EvidenceAuthority {
  if (owner === "oracle") return "oracle-registration";
  if (owner === "reviewer") return "external-visual-review";
  return "runtime-gate-evaluation";
}

function evidenceAuthority(kind: EvidenceRecord["kind"]): EvidenceAuthority {
  if (kind === "registration") return "oracle-registration";
  if (kind === "visual-review") return "external-visual-review";
  if (kind === "turntable") return "runtime-render-capture";
  return "runtime-gate-evaluation";
}

export function isAuthoritativeEvidence(evidence: EvidenceRecord): boolean {
  return evidence.authority === evidenceAuthority(evidence.kind) && evidence.generatorVersion === EVIDENCE_GENERATOR_VERSION;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createTaskState(input: { taskId: string; profile: ProfileId; style: string; certification?: CertificationLevel; styleContractHash?: string; projectConfigurationHash?: string; subjectContractHash?: string | null; articulationRequired?: boolean; authorshipMode?: AuthorshipMode }): TaskState {
  const contract = getProfileContract(input.profile);
  const styleContractHash = input.styleContractHash ?? getStyleContract(input.style).hash;
  const phases = contract.phases.map((phase) => phase.id);
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    profile: input.profile,
    style: input.style,
    certification: input.certification ?? "oracle-relative",
    authoritativeDimensions: { status: "not-admitted", sources: [] },
    status: "active",
    route: "reconstruct",
    oracleHash: null,
    candidateHash: null,
    oraclePreparation: null,
    observedFacts: [],
    userDecisions: [{ id: "style", value: input.style }],
    systemDecisions: [{ id: "profile", value: input.profile, reason: "task routing" }],
    modelInferences: [],
    recommendations: [],
    unresolvedItems: [],
    actions: [],
    verificationResults: [],
    evidence: {},
    attempts: [],
    phaseStatus: Object.fromEntries(phases.map((phase, index) => [phase, index === 0 ? "active" : "pending"])),
    profileContractHash: profileContractHash(contract),
    styleContractHash,
    projectConfigurationHash: input.projectConfigurationHash ?? null,
    subjectContractHash: input.subjectContractHash ?? null,
    articulationRequired: input.articulationRequired ?? contract.articulation.length > 0,
    evaluationIdentity: null,
    evaluationIdentityHash: null,
    activePhase: phases[0]!,
    locks: {},
    reopens: [],
    visualReviewStatus: "awaiting",
    evidenceConfigHashes: {},
    phaseGeometryHashes: {},
    authorshipMode: input.authorshipMode ?? "independent",
    derivedBindings: {},
  };
}

export function skipPhase(state: TaskState, phase: string, reason: string): TaskState {
  if (!reason.trim()) throw new Error("skipped phase requires a reason");
  if (!(phase in state.phaseStatus) || phase === "final") throw new Error(`phase ${phase} cannot be skipped`);
  throw new Error(`phase ${phase} is required by the active profile contract and cannot be skipped`);
}

export function setAuthoritativeDimensionStatus(state: TaskState, status: "not-admitted" | "admitted", sources: string[]): TaskState {
  if (status === "admitted" && !sources.length) throw new Error("admitted authoritative dimensions require at least one source");
  const next = clone(state);
  next.authoritativeDimensions = { status, sources: [...sources] };
  next.systemDecisions.push({ id: "authoritative-dimensions", value: status, reason: status === "admitted" ? sources.join("; ") : "no authoritative dimension source admitted" });
  return next;
}

const ALLOWED_TRANSITIONS: Record<Route, Route[]> = {
  reconstruct: ["onboard-oracle", "build", "diagnose"],
  "onboard-oracle": ["build", "repair-oracle", "diagnose"],
  "repair-oracle": ["build", "diagnose"],
  build: ["visual-review", "diagnose", "repair-oracle"],
  "visual-review": ["build", "finalize", "diagnose"],
  finalize: ["build", "diagnose"],
  diagnose: ["onboard-oracle", "repair-oracle", "build", "visual-review"],
};

export function transitionRoute(state: TaskState, route: Route): TaskState {
  if (!ALLOWED_TRANSITIONS[state.route].includes(route)) throw new Error(`invalid route transition ${state.route} -> ${route}`);
  const next = clone(state);
  next.route = route;
  next.actions.push({ id: `route-${next.actions.length + 1}`, route, description: `transitioned from ${state.route}`, createdAt: new Date().toISOString() });
  return next;
}

function invalidate(state: TaskState, predicate: (evidence: EvidenceRecord) => boolean): void {
  for (const evidence of Object.values(state.evidence)) {
    if (predicate(evidence)) evidence.valid = false;
  }
}

export function bindCandidate(state: TaskState, candidateHash: string): TaskState {
  const next = clone(state);
  if (next.candidateHash && next.candidateHash !== candidateHash) {
    const locked = Object.keys(next.locks).filter((phase) => phase !== "oracle-registration");
    if (locked.length) throw new Error(`candidate geometry cannot change while a locked phase exists: ${locked.join(", ")}; reopen the earliest affected phase first`);
    invalidate(next, (evidence) => ["deterministic-gate", "style", "complexity", "articulation", "visual-review", "turntable"].includes(evidence.kind));
    for (const phase of Object.keys(next.phaseStatus).filter((phase) => phase !== "oracle-registration")) next.phaseStatus[phase] = "invalidated";
    next.visualReviewStatus = "awaiting";
  }
  next.candidateHash = candidateHash;
  return next;
}

export function bindCandidatePhases(state: TaskState, candidateHash: string, phaseHashes: Record<string, string>, evaluationIdentity?: EvaluationIdentity): TaskState {
  const next = clone(state);
  for (const [phase, lock] of Object.entries(next.locks)) {
    if (phase === "oracle-registration") continue;
    if (!phaseHashes[phase] || phaseHashes[phase] !== lock.geometryHash) throw new Error(`candidate changes locked phase geometry: ${phase}; reopen it first`);
  }
  if (next.candidateHash && next.candidateHash !== candidateHash) {
    const lockedEvidenceIds = new Set(Object.values(next.locks).flatMap((lock) => lock.evidence.map((binding) => binding.id)));
    invalidate(next, (evidence) => evidence.kind !== "registration" && !lockedEvidenceIds.has(evidence.id));
    next.visualReviewStatus = "awaiting";
  }
  next.candidateHash = candidateHash;
  next.phaseGeometryHashes = { ...phaseHashes };
  if (evaluationIdentity) {
    const identityHash = evaluationIdentityHash(evaluationIdentity);
    if (candidateHash !== sha256(canonicalJson({ neutralSceneHash: evaluationIdentity.candidateNeutralHash, sourceHash: evaluationIdentity.candidateSourceHash }))) throw new Error("evaluation identity contradicts the candidate hash");
    next.evaluationIdentity = clone(evaluationIdentity);
    next.evaluationIdentityHash = identityHash;
  }
  return next;
}

export function bindOracle(state: TaskState, oracleHash: string): TaskState {
  const next = clone(state);
  if (next.oracleHash && next.oracleHash !== oracleHash) {
    if (Object.keys(next.locks).length) throw new Error("oracle cannot change while phases are locked; reopen oracle-registration first");
    invalidate(next, () => true);
    for (const phase of Object.keys(next.phaseStatus)) next.phaseStatus[phase] = "invalidated";
  }
  next.oracleHash = oracleHash;
  return next;
}

/**
 * Establishes the admitted live oracle preparation as the only oracle authority. A different
 * preparation immediately invalidates every downstream artifact: evidence, locks, geometry hashes,
 * and the canonical evaluation identity are all derived from the preparation, so the chain restarts
 * at oracle registration without the user resetting state fields by hand.
 */
export function bindOraclePreparation(state: TaskState, preparation: OraclePreparationBinding, reason: string): TaskState {
  if (state.oraclePreparation?.identity === preparation.identity && state.oraclePreparation.sourceHash === preparation.sourceHash && state.oraclePreparation.preparedHash === preparation.preparedHash) return state;
  const { phases } = lifecycle(state.profile);
  const next = clone(state);
  next.oraclePreparation = { ...preparation };
  next.status = "active";
  next.oracleHash = null;
  next.evaluationIdentity = null;
  next.evaluationIdentityHash = null;
  next.locks = {};
  next.phaseGeometryHashes = {};
  // Generated modules are bound to the preparation they were derived from; a new preparation
  // makes every recorded derivation binding stale.
  next.derivedBindings = {};
  next.phaseStatus = Object.fromEntries(phases.map((phase, index) => [phase, index === 0 ? "active" : "pending"]));
  next.activePhase = phases[0]!;
  next.visualReviewStatus = "awaiting";
  for (const evidence of Object.values(next.evidence)) { evidence.valid = false; evidence.verified = false; }
  next.systemDecisions.push({
    id: `oracle-preparation-${next.systemDecisions.length + 1}`,
    value: preparation.identity,
    reason: reason.trim() || "oracle preparation changed; prior oracle-bound evidence and locks were invalidated",
  });
  return next;
}

export function recordEvidence(state: TaskState, evidence: Omit<EvidenceRecord, "valid" | "createdAt">): TaskState {
  if (state.oracleHash && evidence.oracleHash !== state.oracleHash) throw new Error("evidence oracle hash does not match state");
  if (evidence.kind !== "registration" && state.candidateHash && evidence.candidateHash !== state.candidateHash) throw new Error("evidence candidate hash does not match state");
  const next = clone(state);
  next.evidence[evidence.id] = { ...evidence, valid: true, verified: false, createdAt: new Date().toISOString() };
  next.verificationResults.push({ id: `verification-${next.verificationResults.length + 1}`, passed: evidence.passed, evidenceId: evidence.id });
  return next;
}

type UnsealedEvidence = Omit<EvidenceArtifact, "schemaVersion" | "generator" | "createdAt" | "artifactHash" | "authority">;
type UnsealedEvidenceInput = Omit<UnsealedEvidence, "styleContractHash" | "evaluationIdentityHash"> & Partial<Pick<UnsealedEvidence, "styleContractHash" | "evaluationIdentityHash">>;

function sealEvidenceArtifact(input: UnsealedEvidenceInput, authority: EvidenceAuthority): EvidenceArtifact {
  const payload = {
    schemaVersion: 3 as const,
    ...input,
    styleContractHash: input.styleContractHash ?? getStyleContract("low-poly-faithful").hash,
    evaluationIdentityHash: input.evaluationIdentityHash ?? (input.kind === "registration" ? null : input.configHash),
    authority,
    generator: { name: "mesh2threejs" as const, version: EVIDENCE_GENERATOR_VERSION },
    createdAt: new Date().toISOString(),
  };
  return { ...payload, artifactHash: sha256(canonicalJson(payload)) };
}

export function createEvidenceArtifact(input: UnsealedEvidenceInput): EvidenceArtifact {
  return sealEvidenceArtifact(input, "declared");
}

export function createRuntimeGateEvidenceArtifact(input: Omit<UnsealedEvidenceInput, "kind" | "gateResults" | "result"> & { report: GateReport }): EvidenceArtifact {
  if (!input.report.rows.length || input.report.rows.some((row) => row.phase !== input.phase)) throw new Error(`runtime gate report is empty or contains rows outside phase ${input.phase}`);
  const { report, ...artifact } = input;
  return sealEvidenceArtifact({
    ...artifact,
    kind: "deterministic-gate",
    gateResults: report.rows.map((row) => ({ code: row.code, passed: row.passed, score: row.score })),
    result: { passed: report.passed, summary: `${input.phase} runtime gate score ${report.score}`, details: report },
  }, "runtime-gate-evaluation");
}

export function createRuntimeEvaluationEvidenceArtifact(input: Omit<UnsealedEvidenceInput, "kind" | "gateResults" | "result"> & { kind: "style" | "complexity" | "articulation"; report: GateReport }): EvidenceArtifact {
  if (!input.report.rows.length) throw new Error(`${input.kind} runtime report is empty`);
  const { report, ...artifact } = input;
  return sealEvidenceArtifact({ ...artifact, result: { passed: report.passed, summary: `${input.kind} runtime score ${report.score}`, details: report } }, "runtime-gate-evaluation");
}

export function createRenderEvidenceArtifact(input: Omit<UnsealedEvidenceInput, "kind" | "gateResults" | "result"> & { manifest: { turntable: Array<{ path: string; sha256: string }>; [key: string]: unknown } }): EvidenceArtifact {
  if (!input.manifest.turntable.length || input.manifest.turntable.some((item) => !item.path.trim() || !/^[a-f0-9]{64}$/u.test(item.sha256))) throw new Error("render evidence requires valid turntable files");
  const { manifest, ...artifact } = input;
  return sealEvidenceArtifact({ ...artifact, kind: "turntable", result: { passed: true, summary: `${manifest.turntable.length} create-only turntable frames`, details: manifest } }, "runtime-render-capture");
}

export function createWorkflowGateEvidenceArtifact(input: Omit<UnsealedEvidenceInput, "gateResults" | "result"> & { gateCode: "registration.complete" | "visual.review"; passed: boolean; summary: string; details?: unknown }): EvidenceArtifact {
  const { gateCode, passed, summary, details, ...artifact } = input;
  const expectedKind = gateCode === "registration.complete" ? "registration" : "visual-review";
  if (artifact.kind !== expectedKind) throw new Error(`${gateCode} evidence must use kind ${expectedKind}`);
  return sealEvidenceArtifact({ ...artifact, gateResults: [{ code: gateCode, passed, score: passed ? 100 : 0 }], result: { passed, summary, ...(details === undefined ? {} : { details }) } }, gateCode === "registration.complete" ? "oracle-registration" : "external-visual-review");
}

export function verifyEvidenceArtifact(artifact: EvidenceArtifact): void {
  const { artifactHash, ...payload } = artifact;
  if (artifact.schemaVersion !== 3 || artifact.generator?.name !== "mesh2threejs" || artifact.generator.version !== EVIDENCE_GENERATOR_VERSION) throw new Error("evidence artifact schema/generator is invalid or unsupported");
  if (!["declared", "runtime-gate-evaluation", "runtime-render-capture", "oracle-registration", "external-visual-review"].includes(artifact.authority)) throw new Error("evidence artifact authority is invalid");
  if (!artifact.styleContractHash) throw new Error("evidence artifact style contract hash is missing");
  if (artifact.kind !== "registration" && !artifact.evaluationIdentityHash) throw new Error("candidate-bound evidence lacks an evaluation identity");
  if (sha256(canonicalJson(payload)) !== artifactHash) throw new Error(`evidence artifact hash is invalid: ${artifact.id}`);
  const gateCodes = new Set<string>();
  for (const gate of artifact.gateResults ?? []) {
    if (!gate.code.trim() || gateCodes.has(gate.code) || !Number.isFinite(gate.score) || gate.score < 0 || gate.score > 100) throw new Error(`evidence artifact has invalid gate results: ${artifact.id}`);
    gateCodes.add(gate.code);
  }
}

export function recordEvidenceArtifact(state: TaskState, artifactPath: string, artifact: EvidenceArtifact): TaskState {
  verifyEvidenceArtifact(artifact);
  if (state.oracleHash !== artifact.oracleHash || (artifact.kind !== "registration" && state.candidateHash !== artifact.candidateHash)) throw new Error("evidence artifact is bound to stale geometry");
  if (state.profileContractHash !== artifact.profileContractHash) throw new Error("evidence artifact profile contract is stale");
  if (state.styleContractHash !== artifact.styleContractHash) throw new Error("evidence artifact style contract is stale");
  if (artifact.kind !== "registration" && state.evaluationIdentityHash && state.evaluationIdentityHash !== artifact.evaluationIdentityHash) throw new Error("evidence artifact evaluation identity is stale");
  const configured = state.evidenceConfigHashes[artifact.kind];
  if (configured && configured !== artifact.configHash) throw new Error(`evidence artifact ${artifact.kind} config is stale; explicitly bind the new config first`);
  if (state.evidence[artifact.id]) throw new Error(`evidence id already exists and cannot be overwritten: ${artifact.id}`);
  const next = clone(state);
  next.evidenceConfigHashes[artifact.kind] = artifact.configHash;
  next.evidence[artifact.id] = {
    id: artifact.id,
    kind: artifact.kind,
    phase: artifact.phase,
    artifact: artifactPath,
    passed: artifact.result.passed,
    oracleHash: artifact.oracleHash,
    candidateHash: artifact.candidateHash,
    valid: true,
    createdAt: artifact.createdAt,
    artifactHash: artifact.artifactHash,
    profileContractHash: artifact.profileContractHash,
    configHash: artifact.configHash,
    verified: true,
    authority: artifact.authority,
    generatorVersion: artifact.generator.version,
    styleContractHash: artifact.styleContractHash,
    evaluationIdentityHash: artifact.evaluationIdentityHash,
    ...(artifact.gateResults ? { gateResults: artifact.gateResults.map((gate) => ({ ...gate })) } : {}),
  };
  if (artifact.kind === "visual-review") next.visualReviewStatus = artifact.result.passed ? "passed" : "failed";
  next.verificationResults.push({ id: `verification-${next.verificationResults.length + 1}`, passed: artifact.result.passed, evidenceId: artifact.id });
  return next;
}

export function bindEvidenceConfig(state: TaskState, kind: EvidenceRecord["kind"], configHash: string, reason: string): TaskState {
  if (!configHash.trim() || !reason.trim()) throw new Error("config changes require a hash and reason");
  const next = clone(state);
  const previous = next.evidenceConfigHashes[kind];
  if (previous && previous !== configHash) {
    invalidate(next, (evidence) => evidence.kind === kind);
    next.systemDecisions.push({ id: `config-${kind}-${next.systemDecisions.length + 1}`, value: configHash, reason: reason.trim() });
    if (kind === "visual-review") next.visualReviewStatus = "awaiting";
  }
  next.evidenceConfigHashes[kind] = configHash;
  return next;
}

export function acceptPhase(state: TaskState, phase: string, input: { geometryHash: string; evidenceIds: string[]; contractHash: string }): TaskState {
  const { phases, dependencies } = lifecycle(state.profile);
  const contract = getProfileContract(state.profile);
  const index = phases.indexOf(phase);
  if (index < 0 || phase === "final") throw new Error(`phase ${phase} cannot be locked`);
  if (input.contractHash !== state.profileContractHash) throw new Error("phase lock contract hash is stale");
  if (!input.evidenceIds.length) throw new Error("phase lock requires verified evidence");
  for (const id of input.evidenceIds) {
    const evidence = state.evidence[id];
    if (!evidence || !evidence.valid || !evidence.verified || !evidence.passed || evidence.phase !== phase) throw new Error(`phase lock evidence is missing, failing, stale, or for another phase: ${id}`);
  }
  const requiredGates = contract.phases.find((item) => item.id === phase)?.requiredGates ?? [];
  const owner = contract.phases.find((item) => item.id === phase)?.owner;
  const requiredAuthority = gateAuthority(owner ?? "builder");
  const suppliedGates = input.evidenceIds.flatMap((id) => state.evidence[id]?.authority === requiredAuthority && state.evidence[id]?.generatorVersion === EVIDENCE_GENERATOR_VERSION ? state.evidence[id]?.gateResults ?? [] : []);
  const gatesByCode = new Map(contract.gates.map((gate) => [gate.code, gate]));
  const missingGates = requiredGates.filter((code) => {
    const threshold = gatesByCode.get(code)?.threshold ?? 100;
    return !suppliedGates.some((gate) => gate.code === code && gate.passed && gate.score >= threshold);
  });
  if (missingGates.length) throw new Error(`phase ${phase} evidence does not prove required gates: ${missingGates.join(", ")}`);
  if (phase !== "oracle-registration" && state.phaseGeometryHashes[phase] && state.phaseGeometryHashes[phase] !== input.geometryHash) throw new Error(`phase ${phase} geometry hash does not match the measured candidate phase`);
  for (const dependency of dependencies[phase] ?? []) {
    if (!state.locks[dependency] && state.phaseStatus[dependency] !== "skipped") throw new Error(`phase ${phase} depends on unlocked phase ${dependency}`);
  }
  const next = clone(state);
  next.locks[phase] = {
    phase,
    geometryHash: input.geometryHash,
    evidence: input.evidenceIds.map((id) => ({ id, artifact: state.evidence[id]!.artifact, artifactHash: state.evidence[id]!.artifactHash! })),
    oracleHash: state.oracleHash ?? "unbound",
    candidateHash: state.candidateHash ?? "unbound",
    contractHash: input.contractHash,
    acceptedAt: new Date().toISOString(),
  };
  next.phaseStatus[phase] = "passed";
  const nextPhase = phases[index + 1];
  if (nextPhase) { next.phaseStatus[nextPhase] = "active"; next.activePhase = nextPhase; }
  return next;
}

export function reopenPhase(state: TaskState, phase: string, reason: string): TaskState {
  if (!reason.trim()) throw new Error("reopening a phase requires a reason");
  const { phases, dependencies } = lifecycle(state.profile);
  const index = phases.indexOf(phase);
  if (index < 0 || !state.locks[phase]) throw new Error(`phase ${phase} is not locked`);
  const invalidated = phases.filter((candidate) => {
    const seen = new Set<string>();
    const dependsOn = (current: string): boolean => current === phase || (dependencies[current] ?? []).some((dependency) => !seen.has(dependency) && (seen.add(dependency), dependsOn(dependency)));
    return dependsOn(candidate);
  });
  const next = clone(state);
  for (const affected of invalidated) {
    delete next.locks[affected];
    delete next.phaseGeometryHashes[affected];
    next.phaseStatus[affected] = "invalidated";
  }
  next.phaseStatus[phase] = "active";
  next.activePhase = phase;
  next.visualReviewStatus = "awaiting";
  invalidate(next, (evidence) => invalidated.includes(evidence.phase));
  next.reopens.push({ phase, reason: reason.trim(), invalidated, reopenedAt: new Date().toISOString() });
  return next;
}

export function recordAttempt(state: TaskState, attempt: Omit<AttemptRecord, "createdAt">): TaskState {
  const next = clone(state);
  next.attempts.push({ ...attempt, createdAt: new Date().toISOString() });
  const recent = next.attempts.slice(-3);
  if (recent.length === 3) {
    const first = recent[0];
    const noNewEvidence = recent.every((item) => item.action === first?.action && item.evidenceHash === first.evidenceHash);
    const noMovement = Math.max(...recent.map((item) => item.score)) - Math.min(...recent.map((item) => item.score)) < 1e-6;
    if (noNewEvidence && noMovement) next.route = "diagnose";
  }
  return next;
}

export function determineNextAction(state: TaskState): { route: Route; reason: string } {
  if (state.route === "diagnose") return { route: "diagnose", reason: "diagnose the recorded stagnation or contradictory evidence before continuing" };
  if (!state.oracleHash) return { route: "onboard-oracle", reason: state.oraclePreparation ? "the bound oracle preparation has not been registered since onboarding, repair, or rebind" : "no admitted oracle is bound to the task" };
  if (!state.candidateHash) return { route: "build", reason: "no procedural candidate is bound to the task" };
  const valid = Object.values(state.evidence).filter((evidence) => evidence.valid && evidence.oracleHash === state.oracleHash && evidence.candidateHash === state.candidateHash);
  const registration = Object.values(state.evidence).find((evidence) => evidence.kind === "registration" && evidence.valid && evidence.verified && evidence.passed && evidence.oracleHash === state.oracleHash && isAuthoritativeEvidence(evidence));
  if (!registration) return { route: "onboard-oracle", reason: "verified registration evidence is missing or failing" };
  const contract = getProfileContract(state.profile);
  if (!state.locks["oracle-registration"]) return { route: "onboard-oracle", reason: "registration evidence is ready but the oracle-registration phase is not locked" };
  const unlockedBuildPhases = contract.phases.filter((phase) => phase.owner === "builder" && !state.locks[phase.id]).map((phase) => phase.id);
  if (unlockedBuildPhases.length) return { route: "build", reason: `builder phases remain unlocked: ${unlockedBuildPhases.join(", ")}` };
  const effectiveRequiredEvidence = [...contract.completion.requiredEvidence, ...(state.articulationRequired && !contract.completion.requiredEvidence.includes("articulation") ? ["articulation"] : [])];
  const buildEvidence = effectiveRequiredEvidence.filter((kind): kind is EvidenceRecord["kind"] => kind !== "registration" && kind !== "visual-review");
  const missingBuildEvidence = buildEvidence.filter((kind) => !valid.some((evidence) => evidence.kind === kind && evidence.verified && evidence.passed && isAuthoritativeEvidence(evidence)));
  if (missingBuildEvidence.length) return { route: "build", reason: `current build evidence is missing or failing: ${missingBuildEvidence.join(", ")}` };
  const visual = valid.find((evidence) => evidence.kind === "visual-review" && evidence.passed && evidence.verified && isAuthoritativeEvidence(evidence));
  if (!visual) return { route: "visual-review", reason: "fresh external visual review evidence is required" };
  if (!state.locks["visual-review"]) return { route: "visual-review", reason: "external review passed but the visual-review phase is not locked" };
  return { route: "finalize", reason: "deterministic and external visual evidence are ready for final certification checks" };
}

export function certifyState(state: TaskState): TaskState {
  if (!state.oracleHash || !state.candidateHash) throw new Error("certification evidence requires oracle and candidate hashes");
  const contract = getProfileContract(state.profile);
  if (state.profileContractHash !== profileContractHash(contract)) throw new Error("certification requires the current executable profile contract");
  if (state.styleContractHash !== getStyleContract(state.style).hash) throw new Error("certification requires the current executable style contract");
  if (!state.evaluationIdentity || state.evaluationIdentityHash !== evaluationIdentityHash(state.evaluationIdentity)) throw new Error("certification requires a current canonical evaluation identity");
  if (state.certification === "exact-real" && state.authoritativeDimensions.status !== "admitted") {
    throw new Error("exact-real certification requires admitted authoritative dimensions");
  }
  const unlocked = contract.phases.map((phase) => phase.id).filter((phase) => phase !== "final" && !state.locks[phase] && state.phaseStatus[phase] !== "skipped");
  if (unlocked.length) throw new Error(`certification has unlocked phases: ${unlocked.join(", ")}`);
  for (const phase of contract.phases.filter((item) => item.id !== "final")) {
    const lock = state.locks[phase.id];
    if (!lock) continue;
    const requiredAuthority = gateAuthority(phase.owner);
    const records = lock.evidence.map((binding) => state.evidence[binding.id]).filter((record): record is EvidenceRecord => Boolean(record));
    if (records.length !== lock.evidence.length || records.some((record) => !record.valid || !record.verified || !record.passed)) throw new Error(`certification phase lock has stale or invalid evidence: ${phase.id}`);
    const gateResults = records.filter((record) => record.authority === requiredAuthority && record.generatorVersion === EVIDENCE_GENERATOR_VERSION).flatMap((record) => record.gateResults ?? []);
    const missingGates = phase.requiredGates.filter((code) => {
      const threshold = contract.gates.find((gate) => gate.code === code)?.threshold ?? 100;
      return !gateResults.some((gate) => gate.code === code && gate.passed && gate.score >= threshold);
    });
    if (missingGates.length) throw new Error(`certification phase lock lacks authoritative gates: ${phase.id}: ${missingGates.join(", ")}`);
  }
  const driftedLocks = Object.values(state.locks).filter((lock) => lock.phase !== "oracle-registration" && state.phaseGeometryHashes[lock.phase] !== lock.geometryHash);
  if (driftedLocks.length) throw new Error(`certification has phase geometry drift: ${driftedLocks.map((lock) => lock.phase).join(", ")}`);
  const finalPhase = contract.phases.find((phase) => phase.id === "final");
  const finalAuthority = finalPhase ? gateAuthority(finalPhase.owner) : "runtime-gate-evaluation";
  const validGateResults = Object.values(state.evidence).filter((evidence) => evidence.valid && evidence.verified && evidence.passed && evidence.oracleHash === state.oracleHash && evidence.candidateHash === state.candidateHash && evidence.authority === finalAuthority && evidence.generatorVersion === EVIDENCE_GENERATOR_VERSION).flatMap((evidence) => evidence.gateResults ?? []);
  const finalMissing = (finalPhase?.requiredGates ?? []).filter((code) => {
    const threshold = contract.gates.find((gate) => gate.code === code)?.threshold ?? 100;
    return !validGateResults.some((gate) => gate.code === code && gate.passed && gate.score >= threshold);
  });
  if (finalMissing.length) throw new Error(`certification final gates are missing or failing: ${finalMissing.join(", ")}`);
  const requiredEvidence = [...contract.completion.requiredEvidence, ...(state.articulationRequired && !contract.completion.requiredEvidence.includes("articulation") ? ["articulation"] : [])] as EvidenceRecord["kind"][];
  const missing = requiredEvidence.filter((kind) => !Object.values(state.evidence).some((evidence) =>
    evidence.kind === kind && evidence.valid && evidence.verified === true && evidence.passed && isAuthoritativeEvidence(evidence) && evidence.oracleHash === state.oracleHash && evidence.styleContractHash === state.styleContractHash && evidence.configHash === state.evidenceConfigHashes[kind] && (kind === "registration" || (evidence.candidateHash === state.candidateHash && evidence.evaluationIdentityHash === state.evaluationIdentityHash))));
  if (missing.length) throw new Error(`certification evidence missing or stale: ${missing.join(", ")}`);
  if (state.unresolvedItems.some((item) => item.blocking)) throw new Error("certification has unresolved blocking items");
  const next = clone(state);
  next.status = "certified";
  next.phaseStatus.final = "passed";
  return next;
}

export async function certifyStateFromArtifacts(state: TaskState, artifactRoot?: string): Promise<TaskState> {
  const artifactPath = (path: string): string => {
    if (!artifactRoot) return path;
    const resolved = isAbsolute(path) ? resolve(path) : resolve(artifactRoot, path);
    const relation = relative(resolve(artifactRoot), resolved);
    if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relation)) throw new Error(`evidence artifact escapes workspace: ${path}`);
    return resolved;
  };
  const turntableHashSets: string[][] = [];
  const reviewedTurntableHashSets: string[][] = [];
  for (const lock of Object.values(state.locks)) {
    for (const binding of lock.evidence) {
      const artifact = JSON.parse(await readFile(artifactPath(binding.artifact), "utf8")) as EvidenceArtifact;
      verifyEvidenceArtifact(artifact);
      const record = state.evidence[binding.id];
      if (!record?.valid || !record.verified || artifact.artifactHash !== binding.artifactHash || artifact.id !== binding.id || artifact.phase !== lock.phase || !artifact.result.passed || artifact.authority !== record.authority || canonicalJson(artifact.gateResults ?? []) !== canonicalJson(record.gateResults ?? [])) throw new Error(`phase lock evidence is stale or contradictory: ${lock.phase}/${binding.id}`);
    }
  }
  for (const evidence of Object.values(state.evidence).filter((item) => item.valid && item.verified)) {
    const artifact = JSON.parse(await readFile(artifactPath(evidence.artifact), "utf8")) as EvidenceArtifact;
    verifyEvidenceArtifact(artifact);
    if (artifact.artifactHash !== evidence.artifactHash || artifact.id !== evidence.id || artifact.result.passed !== evidence.passed || artifact.authority !== evidence.authority || artifact.generator.version !== evidence.generatorVersion || canonicalJson(artifact.gateResults ?? []) !== canonicalJson(evidence.gateResults ?? [])) {
      throw new Error(`evidence artifact contradicts state: ${evidence.id}`);
    }
    if (artifact.kind === "visual-review") {
      const details = artifact.result.details as { packet?: VisualReviewPacket } | undefined;
      if (!details?.packet) throw new Error(`visual review evidence lacks its referenced packet: ${artifact.id}`);
      await verifyVisualReviewPacketFiles(details.packet, artifactRoot);
      reviewedTurntableHashSets.push([...details.packet.turntableHashes].sort());
    }
    if (artifact.kind === "turntable" && artifact.authority === "runtime-render-capture") {
      const details = artifact.result.details as { turntable?: Array<{ path?: string; sha256?: string }> } | undefined;
      if (!details?.turntable?.length) throw new Error(`turntable evidence lacks referenced frames: ${artifact.id}`);
      const hashes: string[] = [];
      for (const frame of details.turntable) {
        if (!frame.path || !frame.sha256) throw new Error(`turntable evidence has an invalid frame reference: ${artifact.id}`);
        if (sha256(await readFile(artifactPath(frame.path))) !== frame.sha256) throw new Error(`turntable evidence frame changed or is incorrect: ${frame.path}`);
        hashes.push(frame.sha256);
      }
      turntableHashSets.push(hashes.sort());
    }
  }
  for (const reviewed of reviewedTurntableHashSets) {
    if (!turntableHashSets.some((rendered) => canonicalJson(rendered) === canonicalJson(reviewed))) throw new Error("visual review turntable does not match authoritative render evidence");
  }
  return certifyState(state);
}

export async function saveTaskState(path: string, state: TaskState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

export async function loadTaskState(path: string): Promise<TaskState> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task state must be an object");
  const state = value as TaskState;
  if ((state.profile === "tank" || state.profile === "generic") && (!state.profileContractHash || !state.locks || !state.reopens || !state.visualReviewStatus || !state.evidenceConfigHashes || !state.phaseGeometryHashes)) {
    const contract = getProfileContract(state.profile);
    const phases = contract.phases.map((phase) => phase.id);
    state.profileContractHash = profileContractHash(contract);
    state.phaseStatus = Object.fromEntries(phases.map((phase, index) => [phase, index === 0 ? "active" : "pending"]));
    state.activePhase = phases[0]!;
    state.locks = {};
    state.reopens = [];
    state.visualReviewStatus = "awaiting";
    state.evidenceConfigHashes = {};
    state.phaseGeometryHashes = {};
    for (const evidence of Object.values(state.evidence ?? {})) { evidence.valid = false; evidence.verified = false; }
    state.systemDecisions ??= [];
    state.systemDecisions.push({ id: "state-contract-migration", value: state.profileContractHash, reason: "migrated legacy state; prior evidence invalidated because it lacks artifact authority" });
  }
  if (state.schemaVersion !== 1 || typeof state.taskId !== "string" || !state.evidence || !Array.isArray(state.observedFacts)
    || !["oracle-relative", "exact-real"].includes(state.certification) || !state.authoritativeDimensions) {
    throw new Error("task state schema is invalid");
  }
  if (!state.profileContractHash || !state.locks || !state.reopens || !state.visualReviewStatus || !state.evidenceConfigHashes || !state.phaseGeometryHashes) throw new Error("task state lacks durable phase/review/config fields");
  state.styleContractHash ??= getStyleContract(state.style).hash;
  state.projectConfigurationHash ??= null;
  state.subjectContractHash ??= null;
  state.articulationRequired ??= getProfileContract(state.profile).articulation.length > 0;
  state.evaluationIdentity ??= null;
  state.evaluationIdentityHash ??= null;
  state.oraclePreparation ??= null;
  // Legacy compatibility rule: states created before derived authorship existed keep
  // independent behavior until the project is explicitly rebound with a declared mode.
  state.authorshipMode ??= "independent";
  state.derivedBindings ??= {};
  const lacksEvidenceAuthority = Object.values(state.evidence).some((evidence) => evidence.valid && evidence.verified && (!evidence.authority || !evidence.generatorVersion));
  if (lacksEvidenceAuthority) {
    const contract = getProfileContract(state.profile);
    const phases = contract.phases.map((phase) => phase.id);
    for (const evidence of Object.values(state.evidence)) { evidence.valid = false; evidence.verified = false; }
    state.locks = {};
    state.phaseGeometryHashes = {};
    state.evidenceConfigHashes = {};
    state.oraclePreparation = null;
    state.phaseStatus = Object.fromEntries(phases.map((phase, index) => [phase, index === 0 ? "active" : "pending"]));
    state.activePhase = phases[0]!;
    state.visualReviewStatus = "awaiting";
    state.status = "active";
    state.systemDecisions.push({ id: "state-evidence-authority-migration", value: EVIDENCE_GENERATOR_VERSION, reason: "invalidated legacy evidence and locks because their evaluation authority cannot be established" });
  }
  const lockedEvidenceIds = new Set(Object.values(state.locks).flatMap((lock) => lock.evidence.map((binding) => binding.id)));
  for (const evidence of Object.values(state.evidence)) {
    const staleCandidate = evidence.kind !== "registration" && state.candidateHash && evidence.candidateHash !== state.candidateHash;
    if (evidence.valid && ((state.oracleHash && evidence.oracleHash !== state.oracleHash) || (staleCandidate && !lockedEvidenceIds.has(evidence.id)))) {
      throw new Error(`task state is contradictory: valid evidence ${evidence.id} is bound to stale hashes`);
    }
    if (evidence.valid && evidence.verified && evidence.configHash !== state.evidenceConfigHashes[evidence.kind]) throw new Error(`task state is contradictory: valid evidence ${evidence.id} has a stale config hash`);
  }
  if (state.status === "certified") certifyState(state);
  return state;
}

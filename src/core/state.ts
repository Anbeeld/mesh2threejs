import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CertificationLevel, ProfileId } from "../types.js";
import type { Route } from "./routing.js";
import { canonicalJson, sha256 } from "./hashing.js";
import { getProfileContract, profileContractHash } from "./contracts.js";

export type SourceStatus = "supports" | "does-not-support" | "not-retrieved" | "contradicted" | "superseded";

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
}

export interface EvidenceArtifact {
  schemaVersion: 2;
  id: string;
  kind: EvidenceRecord["kind"];
  phase: string;
  oracleHash: string;
  candidateHash: string | null;
  profileContractHash: string;
  configHash: string;
  generator: { name: "mesh2threejs"; version: string };
  createdAt: string;
  result: { passed: boolean; summary: string; details?: unknown };
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
  activePhase: string;
  locks: Record<string, PhaseLock>;
  reopens: PhaseReopen[];
  visualReviewStatus: "awaiting" | "passed" | "failed";
  evidenceConfigHashes: Partial<Record<EvidenceRecord["kind"], string>>;
  phaseGeometryHashes: Record<string, string>;
}

function lifecycle(profile: ProfileId): { phases: string[]; dependencies: Record<string, string[]> } {
  const contract = getProfileContract(profile);
  return {
    phases: contract.phases.map((phase) => phase.id),
    dependencies: Object.fromEntries(contract.phases.map((phase) => [phase.id, phase.dependsOn])),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createTaskState(input: { taskId: string; profile: ProfileId; style: string; certification?: CertificationLevel }): TaskState {
  const contract = getProfileContract(input.profile);
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
    activePhase: phases[0]!,
    locks: {},
    reopens: [],
    visualReviewStatus: "awaiting",
    evidenceConfigHashes: {},
    phaseGeometryHashes: {},
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

export function bindCandidatePhases(state: TaskState, candidateHash: string, phaseHashes: Record<string, string>): TaskState {
  const next = clone(state);
  for (const [phase, lock] of Object.entries(next.locks)) {
    if (phase === "oracle-registration") continue;
    if (!phaseHashes[phase] || phaseHashes[phase] !== lock.geometryHash) throw new Error(`candidate changes locked phase geometry: ${phase}; reopen it first`);
  }
  if (next.candidateHash && next.candidateHash !== candidateHash) {
    invalidate(next, (evidence) => evidence.kind !== "registration");
    next.visualReviewStatus = "awaiting";
  }
  next.candidateHash = candidateHash;
  next.phaseGeometryHashes = { ...phaseHashes };
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

export function recordEvidence(state: TaskState, evidence: Omit<EvidenceRecord, "valid" | "createdAt">): TaskState {
  if (state.oracleHash && evidence.oracleHash !== state.oracleHash) throw new Error("evidence oracle hash does not match state");
  if (evidence.kind !== "registration" && state.candidateHash && evidence.candidateHash !== state.candidateHash) throw new Error("evidence candidate hash does not match state");
  const next = clone(state);
  next.evidence[evidence.id] = { ...evidence, valid: true, verified: false, createdAt: new Date().toISOString() };
  next.verificationResults.push({ id: `verification-${next.verificationResults.length + 1}`, passed: evidence.passed, evidenceId: evidence.id });
  return next;
}

export function createEvidenceArtifact(input: Omit<EvidenceArtifact, "schemaVersion" | "generator" | "createdAt" | "artifactHash">): EvidenceArtifact {
  const payload = {
    schemaVersion: 2 as const,
    ...input,
    generator: { name: "mesh2threejs" as const, version: "0.2.0" },
    createdAt: new Date().toISOString(),
  };
  return { ...payload, artifactHash: sha256(canonicalJson(payload)) };
}

export function verifyEvidenceArtifact(artifact: EvidenceArtifact): void {
  const { artifactHash, ...payload } = artifact;
  if (artifact.schemaVersion !== 2 || artifact.generator?.name !== "mesh2threejs") throw new Error("evidence artifact schema/generator is invalid");
  if (sha256(canonicalJson(payload)) !== artifactHash) throw new Error(`evidence artifact hash is invalid: ${artifact.id}`);
}

export function recordEvidenceArtifact(state: TaskState, artifactPath: string, artifact: EvidenceArtifact): TaskState {
  verifyEvidenceArtifact(artifact);
  if (state.oracleHash !== artifact.oracleHash || (artifact.kind !== "registration" && state.candidateHash !== artifact.candidateHash)) throw new Error("evidence artifact is bound to stale geometry");
  if (state.profileContractHash !== artifact.profileContractHash) throw new Error("evidence artifact profile contract is stale");
  const configured = state.evidenceConfigHashes[artifact.kind];
  if (configured && configured !== artifact.configHash) throw new Error(`evidence artifact ${artifact.kind} config is stale; explicitly bind the new config first`);
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
  const index = phases.indexOf(phase);
  if (index < 0 || phase === "final") throw new Error(`phase ${phase} cannot be locked`);
  if (input.contractHash !== state.profileContractHash) throw new Error("phase lock contract hash is stale");
  if (!input.evidenceIds.length) throw new Error("phase lock requires verified evidence");
  for (const id of input.evidenceIds) {
    const evidence = state.evidence[id];
    if (!evidence || !evidence.valid || !evidence.verified || !evidence.passed || evidence.phase !== phase) throw new Error(`phase lock evidence is missing, failing, stale, or for another phase: ${id}`);
  }
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
  if (!state.oracleHash) return { route: "onboard-oracle", reason: "no admitted oracle is bound to the task" };
  if (!state.candidateHash) return { route: "build", reason: "no procedural candidate is bound to the task" };
  const valid = Object.values(state.evidence).filter((evidence) => evidence.valid && evidence.oracleHash === state.oracleHash && evidence.candidateHash === state.candidateHash);
  const registration = Object.values(state.evidence).find((evidence) => evidence.kind === "registration" && evidence.valid && evidence.verified && evidence.passed && evidence.oracleHash === state.oracleHash);
  if (!registration) return { route: "onboard-oracle", reason: "verified registration evidence is missing or failing" };
  const missingBuildEvidence = (["deterministic-gate", "style", "complexity", "articulation", "turntable"] as const).filter((kind) => !valid.some((evidence) => evidence.kind === kind && evidence.verified && evidence.passed));
  if (missingBuildEvidence.length) return { route: "build", reason: `current build evidence is missing or failing: ${missingBuildEvidence.join(", ")}` };
  const visual = valid.find((evidence) => evidence.kind === "visual-review" && evidence.passed && evidence.verified);
  if (!visual) return { route: "visual-review", reason: "fresh external visual review evidence is required" };
  return { route: "finalize", reason: "deterministic and external visual evidence are ready for final certification checks" };
}

export function certifyState(state: TaskState): TaskState {
  if (!state.oracleHash || !state.candidateHash) throw new Error("certification evidence requires oracle and candidate hashes");
  const contract = getProfileContract(state.profile);
  if (state.profileContractHash !== profileContractHash(contract)) throw new Error("certification requires the current executable profile contract");
  if (state.certification === "exact-real" && state.authoritativeDimensions.status !== "admitted") {
    throw new Error("exact-real certification requires admitted authoritative dimensions");
  }
  const unlocked = contract.phases.map((phase) => phase.id).filter((phase) => phase !== "final" && !state.locks[phase] && state.phaseStatus[phase] !== "skipped");
  if (unlocked.length) throw new Error(`certification has unlocked phases: ${unlocked.join(", ")}`);
  const driftedLocks = Object.values(state.locks).filter((lock) => lock.phase !== "oracle-registration" && state.phaseGeometryHashes[lock.phase] !== lock.geometryHash);
  if (driftedLocks.length) throw new Error(`certification has phase geometry drift: ${driftedLocks.map((lock) => lock.phase).join(", ")}`);
  const requiredEvidence = contract.completion.requiredEvidence as EvidenceRecord["kind"][];
  const missing = requiredEvidence.filter((kind) => !Object.values(state.evidence).some((evidence) =>
    evidence.kind === kind && evidence.valid && evidence.verified === true && evidence.passed && evidence.oracleHash === state.oracleHash && evidence.configHash === state.evidenceConfigHashes[kind] && (kind === "registration" || evidence.candidateHash === state.candidateHash)));
  if (missing.length) throw new Error(`certification evidence missing or stale: ${missing.join(", ")}`);
  if (state.unresolvedItems.some((item) => item.blocking)) throw new Error("certification has unresolved blocking items");
  const next = clone(state);
  next.status = "certified";
  next.phaseStatus.final = "passed";
  return next;
}

export async function certifyStateFromArtifacts(state: TaskState): Promise<TaskState> {
  for (const lock of Object.values(state.locks)) {
    for (const binding of lock.evidence) {
      const artifact = JSON.parse(await readFile(binding.artifact, "utf8")) as EvidenceArtifact;
      verifyEvidenceArtifact(artifact);
      if (artifact.artifactHash !== binding.artifactHash || artifact.id !== binding.id || artifact.phase !== lock.phase || !artifact.result.passed) throw new Error(`phase lock evidence is stale or contradictory: ${lock.phase}/${binding.id}`);
    }
  }
  for (const evidence of Object.values(state.evidence).filter((item) => item.valid && item.verified)) {
    const artifact = JSON.parse(await readFile(evidence.artifact, "utf8")) as EvidenceArtifact;
    verifyEvidenceArtifact(artifact);
    if (artifact.artifactHash !== evidence.artifactHash || artifact.id !== evidence.id || artifact.result.passed !== evidence.passed) {
      throw new Error(`evidence artifact contradicts state: ${evidence.id}`);
    }
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
  for (const evidence of Object.values(state.evidence)) {
    if (evidence.valid && ((state.oracleHash && evidence.oracleHash !== state.oracleHash) || (evidence.kind !== "registration" && state.candidateHash && evidence.candidateHash !== state.candidateHash))) {
      throw new Error(`task state is contradictory: valid evidence ${evidence.id} is bound to stale hashes`);
    }
    if (evidence.valid && evidence.verified && evidence.configHash !== state.evidenceConfigHashes[evidence.kind]) throw new Error(`task state is contradictory: valid evidence ${evidence.id} has a stale config hash`);
  }
  if (state.status === "certified") certifyState(state);
  return state;
}

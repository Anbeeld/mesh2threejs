import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CertificationLevel, ProfileId } from "../types.js";
import type { Route } from "./routing.js";

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
  kind: "registration" | "deterministic-gate" | "style" | "complexity" | "articulation" | "critic" | "turntable";
  phase: string;
  artifact: string;
  passed: boolean;
  oracleHash: string;
  candidateHash: string;
  valid: boolean;
  createdAt: string;
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
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createTaskState(input: { taskId: string; profile: ProfileId; style: string; certification?: CertificationLevel }): TaskState {
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
    phaseStatus: { oracle: "pending", geometry: "pending", style: "pending", critic: "pending", final: "pending" },
  };
}

export function skipPhase(state: TaskState, phase: string, reason: string): TaskState {
  if (!reason.trim()) throw new Error("skipped phase requires a reason");
  if (!(phase in state.phaseStatus) || phase === "final") throw new Error(`phase ${phase} cannot be skipped`);
  const next = clone(state);
  next.phaseStatus[phase] = "skipped";
  next.systemDecisions.push({ id: `skip-${phase}`, value: true, reason: reason.trim() });
  return next;
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
  build: ["critic", "diagnose", "repair-oracle"],
  critic: ["build", "finalize", "diagnose"],
  finalize: ["build", "diagnose"],
  diagnose: ["onboard-oracle", "repair-oracle", "build", "critic"],
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
    invalidate(next, (evidence) => evidence.candidateHash !== candidateHash || ["deterministic-gate", "style", "complexity", "articulation", "critic", "turntable"].includes(evidence.kind));
    for (const phase of ["geometry", "style", "critic", "final"]) next.phaseStatus[phase] = "invalidated";
  }
  next.candidateHash = candidateHash;
  return next;
}

export function bindOracle(state: TaskState, oracleHash: string): TaskState {
  const next = clone(state);
  if (next.oracleHash && next.oracleHash !== oracleHash) {
    invalidate(next, () => true);
    for (const phase of Object.keys(next.phaseStatus)) next.phaseStatus[phase] = "invalidated";
  }
  next.oracleHash = oracleHash;
  return next;
}

export function recordEvidence(state: TaskState, evidence: Omit<EvidenceRecord, "valid" | "createdAt">): TaskState {
  if (state.oracleHash && evidence.oracleHash !== state.oracleHash) throw new Error("evidence oracle hash does not match state");
  if (state.candidateHash && evidence.candidateHash !== state.candidateHash) throw new Error("evidence candidate hash does not match state");
  const next = clone(state);
  next.evidence[evidence.id] = { ...evidence, valid: true, createdAt: new Date().toISOString() };
  next.verificationResults.push({ id: `verification-${next.verificationResults.length + 1}`, passed: evidence.passed, evidenceId: evidence.id });
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
  const deterministic = valid.find((evidence) => evidence.kind === "deterministic-gate" && evidence.passed);
  const style = valid.find((evidence) => evidence.kind === "style" && evidence.passed);
  if (!deterministic || !style) return { route: "build", reason: "geometry or style evidence is missing or failing" };
  const critic = valid.find((evidence) => evidence.kind === "critic" && evidence.passed);
  if (!critic) return { route: "critic", reason: "fresh independent critic evidence is required" };
  return { route: "finalize", reason: "deterministic and critic evidence are ready for final certification checks" };
}

const REQUIRED_EVIDENCE: EvidenceRecord["kind"][] = ["registration", "deterministic-gate", "style", "complexity", "articulation", "critic", "turntable"];

export function certifyState(state: TaskState): TaskState {
  if (!state.oracleHash || !state.candidateHash) throw new Error("certification evidence requires oracle and candidate hashes");
  if (state.certification === "exact-real" && state.authoritativeDimensions.status !== "admitted") {
    throw new Error("exact-real certification requires admitted authoritative dimensions");
  }
  const missing = REQUIRED_EVIDENCE.filter((kind) => !Object.values(state.evidence).some((evidence) =>
    evidence.kind === kind && evidence.valid && evidence.passed && evidence.oracleHash === state.oracleHash && evidence.candidateHash === state.candidateHash));
  if (missing.length) throw new Error(`certification evidence missing or stale: ${missing.join(", ")}`);
  if (state.unresolvedItems.some((item) => item.blocking)) throw new Error("certification has unresolved blocking items");
  const next = clone(state);
  next.status = "certified";
  next.phaseStatus.final = "passed";
  return next;
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
  if (state.schemaVersion !== 1 || typeof state.taskId !== "string" || !state.evidence || !Array.isArray(state.observedFacts)
    || !["oracle-relative", "exact-real"].includes(state.certification) || !state.authoritativeDimensions) {
    throw new Error("task state schema is invalid");
  }
  for (const evidence of Object.values(state.evidence)) {
    if (evidence.valid && ((state.oracleHash && evidence.oracleHash !== state.oracleHash) || (state.candidateHash && evidence.candidateHash !== state.candidateHash))) {
      throw new Error(`task state is contradictory: valid evidence ${evidence.id} is bound to stale hashes`);
    }
  }
  if (state.status === "certified") certifyState(state);
  return state;
}

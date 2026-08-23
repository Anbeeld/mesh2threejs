import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256 } from "./hashing.js";
import { rowsToWorkorders } from "./compare.js";
import type { GateReport, GateRow, ProfileId } from "../types.js";

export const EXECUTABLE_OPERATORS = [
  "adaptive-orthographic-curves", "articulation-poses", "attachments", "bounds-robust",
  "connectivity", "critical-semantics", "fabrication", "hull-pinned-registration",
  "landmarks", "physical-orientation", "repeated-instances", "sections", "track-course",
  "style-contract", "complexity-budget",
] as const;

export type ExecutableOperator = typeof EXECUTABLE_OPERATORS[number];

interface RuntimeGateBinding {
  operator: ExecutableOperator;
  source: "deterministic" | "articulation" | "style" | "workflow";
  exact?: string[];
  prefixes?: string[];
  allowEmpty?: boolean;
  excludePrefixes?: string[];
}

const RUNTIME_GATE_BINDINGS: Record<string, RuntimeGateBinding> = {
  "registration.complete": { operator: "critical-semantics", source: "workflow" },
  "registration.frame": { operator: "physical-orientation", source: "deterministic", exact: ["registration.frame"] },
  "registration.ownership": { operator: "connectivity", source: "deterministic", exact: ["registration.ownership"] },
  "curves.hull": { operator: "adaptive-orthographic-curves", source: "deterministic", exact: ["curves.hull"] },
  "hull.stations": { operator: "sections", source: "deterministic", exact: ["hull.stations"] },
  "hull.sections": { operator: "sections", source: "deterministic", exact: ["hull.sections"] },
  "hull.planes": { operator: "sections", source: "deterministic", exact: ["hull.planes"] },
  "hull.contiguity": { operator: "connectivity", source: "deterministic", exact: ["hull.contiguity"] },
  "dimensions.hull-length": { operator: "bounds-robust", source: "deterministic", exact: ["dimensions.hull-length"] },
  "orientation.physical": { operator: "physical-orientation", source: "deterministic", exact: ["orientation.physical"] },
  "curves.turret": { operator: "adaptive-orthographic-curves", source: "deterministic", exact: ["curves.turret"] },
  "turret.sections": { operator: "sections", source: "deterministic", exact: ["turret.sections"] },
  "turret.placement": { operator: "landmarks", source: "deterministic", exact: ["turret.placement"] },
  "turret.contiguity": { operator: "connectivity", source: "deterministic", exact: ["turret.contiguity"] },
  "gun.geometry": { operator: "landmarks", source: "deterministic", exact: ["gun.geometry"] },
  "gun.pose": { operator: "articulation-poses", source: "deterministic", exact: ["gun.pose"] },
  "running-gear.count": { operator: "repeated-instances", source: "deterministic", exact: ["running-gear.count"] },
  "running-gear.instances": { operator: "repeated-instances", source: "deterministic", exact: ["running-gear.instances"] },
  "running-gear.spacing": { operator: "repeated-instances", source: "deterministic", exact: ["running-gear.spacing"] },
  "running-gear.radiality": { operator: "repeated-instances", source: "deterministic", exact: ["running-gear.radiality"] },
  "running-gear.axles": { operator: "physical-orientation", source: "deterministic", exact: ["running-gear.axles"] },
  "track.course": { operator: "track-course", source: "deterministic", exact: ["track.course"] },
  "articulation.poses": { operator: "articulation-poses", source: "articulation", prefixes: ["articulation.pose."] },
  "ownership.seating": { operator: "connectivity", source: "deterministic", exact: ["ownership.seating"] },
  "fabrication.profile": { operator: "fabrication", source: "deterministic", exact: ["fabrication.profile"] },
  "visual.review": { operator: "critical-semantics", source: "workflow" },
  "curves.whole": { operator: "adaptive-orthographic-curves", source: "deterministic", exact: ["curves.whole"] },
  "dimensions.robust": { operator: "bounds-robust", source: "deterministic", prefixes: ["dimensions."] },
  "silhouette.views": { operator: "adaptive-orthographic-curves", source: "deterministic", prefixes: ["silhouette."] },
  "attachments.contract": { operator: "attachments", source: "deterministic", prefixes: ["attachment."], allowEmpty: true },
  "semantics.critical": { operator: "critical-semantics", source: "deterministic", prefixes: ["semantic.", "critical-feature."] },
  "connectivity.contract": { operator: "connectivity", source: "deterministic", prefixes: ["connectivity."] },
  "style.contract": { operator: "style-contract", source: "style", prefixes: ["style."], excludePrefixes: ["style.complexity."] },
  "style.complexity": { operator: "complexity-budget", source: "style", prefixes: ["style.complexity."] },
};

export interface ProfilePhaseContract {
  id: string;
  dependsOn: string[];
  owner: "oracle" | "builder" | "reviewer" | "finalizer";
  requiredGates: string[];
}

export interface ProfileGateContract {
  code: string;
  phase: string;
  operator: ExecutableOperator;
  required: boolean;
  threshold: number;
  views?: string[];
}

export interface ProfileContract {
  schemaVersion: 2;
  id: ProfileId;
  semantics: { required: string[]; optional: string[]; critical: string[] };
  operators: ExecutableOperator[];
  phases: ProfilePhaseContract[];
  gates: ProfileGateContract[];
  dimensions: string[];
  articulation: Array<{ control: string; moving: string[]; stationary: string[]; samples: number[] }>;
  repeats: Array<{ role: string; orderedBy: "x" | "y" | "z"; sideAxis?: "x" | "y" | "z" }>;
  stylePermissions: { maySimplify: string[]; mustPreserve: string[] };
  completion: { requiresVisualReview: boolean; requiredEvidence: string[] };
}

export interface ContractValidation {
  valid: boolean;
  errors: string[];
  hash?: string;
}

export function validateProfileContract(value: unknown): ContractValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["contract must be an object"] };
  const contract = value as Partial<ProfileContract>;
  if (contract.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (contract.id !== "tank" && contract.id !== "generic") errors.push("id must be tank or generic");
  if (!Array.isArray(contract.phases) || !contract.phases.length) errors.push("phases must be non-empty");
  if (!Array.isArray(contract.gates) || !contract.gates.length) errors.push("gates must be non-empty");
  const operators = new Set(EXECUTABLE_OPERATORS);
  for (const operator of contract.operators ?? []) if (!operators.has(operator)) errors.push(`unknown operator: ${operator}`);
  const usedOperators = new Set((contract.gates ?? []).map((gate) => gate.operator));
  for (const operator of new Set(contract.operators ?? [])) if (!usedOperators.has(operator)) errors.push(`operator ${operator} is enabled but unused by every gate`);
  const phaseIds = new Set((contract.phases ?? []).map((phase) => phase.id));
  const gateCodes = new Set((contract.gates ?? []).map((gate) => gate.code));
  if (phaseIds.size !== (contract.phases ?? []).length) errors.push("phase ids must be unique");
  if (gateCodes.size !== (contract.gates ?? []).length) errors.push("gate codes must be unique");
  const owners = new Set(["oracle", "builder", "reviewer", "finalizer"]);
  for (const phase of contract.phases ?? []) {
    if (!phase.id || !owners.has(phase.owner)) errors.push(`phase ${phase.id || "<missing>"} requires a supported owner`);
    for (const dependency of phase.dependsOn ?? []) if (!phaseIds.has(dependency)) errors.push(`phase ${phase.id} has missing dependency ${dependency}`);
    for (const gate of phase.requiredGates ?? []) if (!gateCodes.has(gate)) errors.push(`phase ${phase.id} requires gate that is never emitted: ${gate}`);
  }
  for (const gate of contract.gates ?? []) {
    if (!phaseIds.has(gate.phase)) errors.push(`gate ${gate.code} has unknown phase ${gate.phase}`);
    if (!operators.has(gate.operator)) errors.push(`gate ${gate.code} uses unknown operator ${gate.operator}`);
    if (!(contract.operators ?? []).includes(gate.operator)) errors.push(`gate ${gate.code} operator ${gate.operator} is not enabled`);
    const binding = RUNTIME_GATE_BINDINGS[gate.code];
    if (!binding) errors.push(`gate ${gate.code} is not emitted by the runtime`);
    else if (binding.operator !== gate.operator) errors.push(`gate ${gate.code} declares ${gate.operator} but runtime uses ${binding.operator}`);
    if (!Number.isFinite(gate.threshold) || gate.threshold < 0 || gate.threshold > 100) errors.push(`gate ${gate.code} threshold must be between 0 and 100`);
  }
  const requiredSemantics = new Set(contract.semantics?.required ?? []);
  for (const critical of contract.semantics?.critical ?? []) if (!requiredSemantics.has(critical)) errors.push(`critical semantic ${critical} must be required`);
  if (!contract.completion?.requiresVisualReview) errors.push("completion must require visual review");
  const evidenceKinds = new Set(["registration", "deterministic-gate", "style", "complexity", "articulation", "visual-review", "turntable"]);
  if (!Array.isArray(contract.completion?.requiredEvidence) || !contract.completion.requiredEvidence.length) errors.push("completion requires an evidence list");
  for (const kind of contract.completion?.requiredEvidence ?? []) if (!evidenceKinds.has(kind)) errors.push(`completion requires unsupported evidence: ${kind}`);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const byPhase = new Map((contract.phases ?? []).map((phase) => [phase.id, phase]));
  const visit = (id: string): void => {
    if (visiting.has(id)) { errors.push(`phase dependency cycle includes ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byPhase.get(id)?.dependsOn ?? []) if (byPhase.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of phaseIds) visit(id);
  return errors.length ? { valid: false, errors } : { valid: true, errors, hash: sha256(canonicalJson(contract)) };
}

export function evaluateProfileContractGates(
  contract: ProfileContract,
  input: { deterministic?: GateRow[]; articulation?: GateRow[]; style?: GateRow[] },
): GateReport {
  const rows: GateRow[] = [];
  for (const gate of contract.gates) {
    const binding = RUNTIME_GATE_BINDINGS[gate.code];
    if (!binding || binding.source === "workflow") continue;
    const available = binding.source === "deterministic" ? input.deterministic : binding.source === "articulation" ? input.articulation : input.style;
    if (!available) continue;
    const selected = available.filter((row) => (binding.exact?.includes(row.code) || binding.prefixes?.some((prefix) => row.code.startsWith(prefix))) && !binding.excludePrefixes?.some((prefix) => row.code.startsWith(prefix)));
    const evaluatedViews = new Set(selected.flatMap((row) => row.viewsEvaluated ?? (row.view ? [row.view] : [])));
    const missingViews = (gate.views ?? []).filter((view) => !evaluatedViews.has(view));
    const hasEvidence = selected.length > 0 || binding.allowEmpty === true;
    const score = selected.length ? Math.min(...selected.map((row) => row.score)) : hasEvidence ? 100 : 0;
    const passed = hasEvidence && selected.every((row) => row.passed) && score >= gate.threshold && missingViews.length === 0;
    rows.push({
      code: gate.code,
      phase: gate.phase,
      component: "profile-contract",
      passed,
      score,
      severity: gate.required ? "critical" : "major",
      message: missingViews.length
        ? `${gate.code} did not evaluate required views: ${missingViews.join(", ")}`
        : hasEvidence ? `${gate.code} runtime evidence floor ${score.toFixed(1)}; required ${gate.threshold}` : `${gate.code} emitted no runtime evidence`,
      oracleValue: gate.threshold,
      candidateValue: score,
      deviation: score - gate.threshold,
      ...(gate.views ? { viewsEvaluated: [...evaluatedViews].sort() } : {}),
    });
  }
  return {
    profile: contract.id,
    passed: rows.every((row) => row.passed),
    score: rows.length ? Math.min(...rows.map((row) => row.score)) : 100,
    rows,
    workorders: rowsToWorkorders(rows),
  };
}

export function getProfileContract(profile: ProfileId): ProfileContract {
  const path = fileURLToPath(new URL(`../../profiles/${profile}/contract.json`, import.meta.url));
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const validation = validateProfileContract(value);
  if (!validation.valid) throw new Error(`profile contract ${profile} is invalid: ${validation.errors.join("; ")}`);
  return structuredClone(value) as ProfileContract;
}

export async function loadProfileContract(profile: ProfileId): Promise<ProfileContract> {
  return getProfileContract(profile);
}

export function profileContractHash(contract: ProfileContract): string {
  const validation = validateProfileContract(contract);
  if (!validation.valid || !validation.hash) throw new Error(`invalid profile contract: ${validation.errors.join("; ")}`);
  return validation.hash;
}

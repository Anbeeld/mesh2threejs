import * as THREE from "three";
import type { CandidateRuntime, ProfileId } from "../types.js";
import { getProfileContract } from "./contracts.js";
import type { ExclusionProtectionPolicy } from "./oracle.js";

/**
 * Single authoritative phase-semantic ownership model. Every consumer — phase scope checks,
 * phase candidate composition, derivation replacement — reads ownership through this module
 * instead of maintaining parallel regex vocabularies that drift apart.
 */
export type SemanticOwnershipPredicate = (id: string, role?: string) => boolean;

const ADMIT_ALL: SemanticOwnershipPredicate = () => true;

const TANK_PHASE_SEMANTIC_OWNERSHIP: Record<string, SemanticOwnershipPredicate> = {
  hull: (id) => id.startsWith("hull"),
  // Multipart turret assemblies: every significant turret-prefixed child (cheeks, roof
  // plates, cupola) is owned by the turret phase through the single authoritative resolver.
  turret: (id) => id === "turret" || id === "turret-pivot" || id === "cupola" || /^turret(?:[-_ ].*)?$/u.test(id),
  gun: (id) => id === "gun" || id === "gun-pivot",
  "running-gear": (id, role) =>
    (role !== undefined && ["road-wheel", "sprocket", "idler", "return-roller"].includes(role))
    || /^(?:road-wheel|sprocket|idler|return-roller)(?:[-_ ].*)?$/u.test(id),
  tracks: (id, role) => role === "track-course" || id === "track-course" || /^track(?:[-_ ].*)?$/u.test(id),
  // Post-tracks builder phases may carry remaining declared semantics (cupola-class extras,
  // antennas, fittings) without special-case bypasses elsewhere.
  "fittings-articulation": ADMIT_ALL,
  "style-fabrication": ADMIT_ALL,
  "visual-review": ADMIT_ALL,
  final: ADMIT_ALL,
};

function profilePhaseOwnership(profile: ProfileId): Record<string, SemanticOwnershipPredicate> | null {
  return profile === "tank" ? TANK_PHASE_SEMANTIC_OWNERSHIP : null;
}

/**
 * Cumulative predecessor set of one phase, taken from the executable profile contract.
 * The pipeline locks phases in contract ARRAY order (acceptPhase advances to the next
 * entry), so predecessors are the contract-order prefix through the active phase — plain
 * dependsOn closure would miss earlier phases a phase does not declare directly
 * (e.g. running-gear declares only hull, yet turret/gun are legitimately locked first).
 */
export function phaseWithPrerequisites(profile: ProfileId, phase: string): string[] {
  const contract = getProfileContract(profile);
  const index = contract.phases.findIndex((entry) => entry.id === phase);
  if (index < 0) return [phase];
  return contract.phases.slice(0, index + 1).map((entry) => entry.id);
}

/**
 * Contract-order suffix invalidated by reopening one phase (pipeline remediation plan D3/C1).
 * The pipeline locks phases in contract ARRAY order and phaseWithPrerequisites() defines the
 * legal cumulative scope as the contract-order prefix — so reopening the phase at index i
 * releases exactly the suffix phases[i:]. The former dependsOn-closure interpretation was a
 * different lifecycle model and let later-phase semantics survive a reopen while remaining
 * illegal in active-phase composition. This ONE definition is used by reopen state
 * invalidation, generated-binding pruning, and workspace reconciliation alike.
 */
export function phasesInvalidatedByReopen(profile: ProfileId, phase: string): string[] {
  const contract = getProfileContract(profile);
  const index = contract.phases.findIndex((entry) => entry.id === phase);
  if (index < 0) return [phase];
  return contract.phases.slice(index).map((entry) => entry.id);
}

/**
 * Cumulative semantic scope for an active phase: semantics owned by the phase itself plus
 * every prerequisite phase. Returns null for profiles without an ownership model, meaning
 * "no mechanical restriction".
 */
export function phaseSemanticScope(profile: ProfileId, phase: string): SemanticOwnershipPredicate | null {
  const ownership = profilePhaseOwnership(profile);
  if (!ownership) return null;
  const predicates = phaseWithPrerequisites(profile, phase)
    .map((id) => ownership[id])
    .filter((predicate): predicate is SemanticOwnershipPredicate => Boolean(predicate));
  return (id, role) => predicates.some((predicate) => predicate(id, role));
}

/** Semantics owned exactly by ONE phase (not cumulative); used to select replacement targets. */
export function phaseOwnedSemantics(profile: ProfileId, phase: string): SemanticOwnershipPredicate | null {
  return profilePhaseOwnership(profile)?.[phase] ?? null;
}

/**
 * Source phases whose owned semantics are REQUIRED executable geometry: derivation,
 * fidelity, and required gates depend on their source subtrees, so those subtrees may
 * never be silently assembly-excluded. Generic profiles protect contract-required
 * semantics through the contract path instead; a future profile either declares its
 * required semantics in its contract or lists its executable phases here.
 */
const PROTECTED_SOURCE_PHASES: Partial<Record<ProfileId, readonly string[]>> = {
  tank: ["hull", "turret", "gun", "running-gear", "tracks"],
};

/**
 * Derives the assembly-exclusion protection policy for a profile from the executable
 * contract (required/critical semantics) plus this module's protected source-phase
 * ownership. This is profile-owned authority: oracle validation stays generic and never
 * hardcodes per-subject semantic vocabularies.
 */
export function protectedSourceSemantics(profile: ProfileId): ExclusionProtectionPolicy {
  const contract = getProfileContract(profile);
  const declared = new Set([...contract.semantics.required, ...contract.semantics.critical]);
  const ownership = profilePhaseOwnership(profile);
  const predicates = (PROTECTED_SOURCE_PHASES[profile] ?? [])
    .map((phase) => ownership?.[phase])
    .filter((predicate): predicate is SemanticOwnershipPredicate => Boolean(predicate));
  return (semanticId) => declared.has(semanticId) || predicates.some((owns) => owns(semanticId));
}

export class PhaseCompositionError extends Error {}

/** A candidate runtime whose temporary composition can be undone after evaluation. */
export interface ComposedCandidateRuntime extends CandidateRuntime {
  dispose: () => void;
}

export interface PhaseCompositionInput {
  profile: ProfileId;
  phase: string;
  liveCandidate: CandidateRuntime;
  replacement: THREE.Object3D;
}

/**
 * Contextual phase evaluation primitive: locked prerequisite geometry + proposed replacement
 * geometry − previous active-phase geometry − future-phase geometry. The live candidate graph
 * is borrowed, never permanently mutated: active-phase subtrees are temporarily detached and
 * the replacement rides alongside as a sibling under a disposable evaluation root, so the
 * candidate's own setPose implementation keeps driving the real locked pivots. dispose()
 * restores the exact prior graph; callers MUST call it after evaluation (normally finally).
 */
export function composeCandidateForPhase(input: PhaseCompositionInput): ComposedCandidateRuntime {
  const { profile, phase, liveCandidate, replacement } = input;
  const ownsActive = phaseOwnedSemantics(profile, phase);
  if (!ownsActive) throw new PhaseCompositionError(`profile ${profile} has no phase semantic ownership model; cannot compose phase ${phase}`);
  const allowed = phaseSemanticScope(profile, phase);

  interface SemanticObject { object: THREE.Object3D; semanticId: string; role?: string }
  const semanticObjects: SemanticObject[] = [];
  liveCandidate.root.traverse((object) => {
    const semanticId = object.userData?.semanticId;
    if (typeof semanticId !== "string") return;
    const role = typeof object.userData?.semanticRole === "string" ? object.userData.semanticRole : undefined;
    if (allowed && !allowed(semanticId, role)) {
      throw new PhaseCompositionError(`phase composition invalid: live candidate carries semantics ${semanticId} outside the cumulative scope of phase ${phase}`);
    }
    semanticObjects.push({ object, semanticId, ...(role ? { role } : {}) });
  });

  // Detach only TOP-MOST active-phase owners; their subtrees leave with them.
  const activeIds = new Set(semanticObjects.filter((entry) => ownsActive(entry.semanticId, entry.role)).map((entry) => entry.object));
  const detached: Array<{ object: THREE.Object3D; parent: THREE.Object3D }> = [];
  for (const entry of semanticObjects) {
    if (!activeIds.has(entry.object)) continue;
    let ancestor = entry.object.parent;
    let nested = false;
    while (ancestor) {
      if (activeIds.has(ancestor)) { nested = true; break; }
      ancestor = ancestor.parent;
    }
    if (nested) continue;
    if (!entry.object.parent) continue;
    detached.push({ object: entry.object, parent: entry.object.parent });
  }
  for (const entry of detached) entry.parent.remove(entry.object);

  const evaluationRoot = new THREE.Group();
  evaluationRoot.name = "phase-composition-evaluation";
  evaluationRoot.add(liveCandidate.root);
  evaluationRoot.add(replacement);

  let disposed = false;
  return {
    root: evaluationRoot,
    setPose: (pose) => liveCandidate.setPose(pose),
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      evaluationRoot.remove(liveCandidate.root);
      evaluationRoot.remove(replacement);
      for (const entry of detached.reverse()) entry.parent.add(entry.object);
    },
  };
}

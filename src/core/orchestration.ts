import type * as THREE from "three";
import type { GateReport, ProfileId } from "../types.js";
import { snapshotScene } from "./geometry.js";
import { fingerprintScene, fingerprintSnapshot } from "./hashing.js";
import { evaluateGenericProfile, type GenericSubjectContract } from "../profiles/generic.js";
import { evaluateTankProfile } from "../profiles/tank.js";
import { evaluateLowPolyStyle, lowPolyFaithful, type StyleContract } from "../styles/low-poly.js";
import { captureSemanticTransforms, checkArticulation } from "./measurement.js";
import type { CandidateRuntime, GateRow } from "../types.js";
import { canonicalJson, sha256 } from "./hashing.js";
import { evaluateProfileContractGates, getProfileContract } from "./contracts.js";

export interface EvaluationBundle {
  oracleHash: string;
  candidateHash: string;
  deterministic: GateReport;
  style: GateReport;
  contractGates: GateReport;
  passed: boolean;
  phaseGeometryHashes: Record<string, string>;
}

function phaseGeometryHashes(profile: ProfileId, snapshot: ReturnType<typeof snapshotScene>): Record<string, string> {
  const ids = Object.values(snapshot.components);
  const matching = (predicate: (id: string, role?: string) => boolean): ReadonlySet<string> => new Set(ids.filter((component) => predicate(component.id, component.role)).map((component) => component.id));
  if (profile === "tank") return {
    hull: fingerprintSnapshot(snapshot, matching((id) => id.startsWith("hull")), { includeMaterials: false }),
    turret: fingerprintSnapshot(snapshot, matching((id) => id === "turret" || id === "turret-pivot" || id === "cupola"), { includeMaterials: false }),
    gun: fingerprintSnapshot(snapshot, matching((id) => id === "gun" || id === "gun-pivot"), { includeMaterials: false }),
    "running-gear": fingerprintSnapshot(snapshot, matching((id, role) => ["road-wheel", "sprocket", "idler", "return-roller"].includes(role ?? "") || /^(road-wheel|sprocket|idler|return-roller)-/u.test(id)), { includeMaterials: false }),
    tracks: fingerprintSnapshot(snapshot, matching((id, role) => role === "track-course" || id.startsWith("track-")), { includeMaterials: false }),
    "fittings-articulation": fingerprintSnapshot(snapshot, undefined, { includeMaterials: false }),
    "style-fabrication": fingerprintSnapshot(snapshot),
    "visual-review": fingerprintSnapshot(snapshot),
  };
  return {
    "primary-mass": fingerprintSnapshot(snapshot, matching((id) => id === "primary"), { includeMaterials: false }),
    attachments: fingerprintSnapshot(snapshot, matching((id) => id === "attachment"), { includeMaterials: false }),
    "identity-features": fingerprintSnapshot(snapshot, new Set(ids.filter((component) => component.critical || component.role === "identity-feature").map((component) => component.id)), { includeMaterials: false }),
    "style-complexity": fingerprintSnapshot(snapshot),
    "visual-review": fingerprintSnapshot(snapshot),
  };
}

export interface PosedEvaluationBundle extends EvaluationBundle {
  articulation: GateReport;
}

export function evaluateCandidate(input: {
  oracle: THREE.Object3D;
  candidate: THREE.Object3D;
  profile: ProfileId;
  style?: StyleContract;
  authoritativeDimensions?: { hullLength: number; overallLength: number; width: number; height: number };
  certification?: "exact-real" | "oracle-relative";
  subjectContract?: GenericSubjectContract;
}): EvaluationBundle {
  const oracleSnapshot = snapshotScene(input.oracle);
  const candidateSnapshot = snapshotScene(input.candidate);
  const deterministic = input.profile === "tank"
    ? evaluateTankProfile(oracleSnapshot, candidateSnapshot, {
        certification: input.certification ?? "oracle-relative",
        ...(input.authoritativeDimensions ? { authoritativeDimensions: input.authoritativeDimensions } : {}),
      })
    : evaluateGenericProfile(oracleSnapshot, candidateSnapshot, input.subjectContract);
  const style = evaluateLowPolyStyle(oracleSnapshot, candidateSnapshot, input.style ?? lowPolyFaithful);
  const contractGates = evaluateProfileContractGates(getProfileContract(input.profile), { deterministic: deterministic.rows });
  return {
    oracleHash: fingerprintScene(input.oracle),
    candidateHash: fingerprintScene(input.candidate),
    deterministic,
    style,
    contractGates,
    passed: deterministic.passed && style.passed && contractGates.passed,
    phaseGeometryHashes: phaseGeometryHashes(input.profile, candidateSnapshot),
  };
}

export async function evaluateCandidateWithPoses(input: Omit<Parameters<typeof evaluateCandidate>[0], "candidate"> & { candidate: CandidateRuntime }): Promise<PosedEvaluationBundle> {
  const base = evaluateCandidate({ ...input, candidate: input.candidate.root });
  if (input.candidate.sourceHash) base.candidateHash = sha256(canonicalJson({ neutralSceneHash: base.candidateHash, sourceHash: input.candidate.sourceHash }));
  const rows: GateRow[] = [];
  if (input.profile === "tank") {
    const semanticSnapshot = snapshotScene(input.candidate.root);
    const descendantsOf = (ancestor: string): string[] => Object.values(semanticSnapshot.components).filter((component) => {
      let current: typeof component | undefined = component;
      while (current?.parentSemanticId) {
        if (current.parentSemanticId === ancestor) return true;
        current = semanticSnapshot.components[current.parentSemanticId];
      }
      return component.id === ancestor;
    }).map((component) => component.id);
    const turretOwned = descendantsOf("turret-pivot");
    const gunOwned = descendantsOf("gun-pivot");
    const allSemantics = Object.keys(semanticSnapshot.components);
    const neutral = { turretYaw: 0, gunElevation: 0 };
    await input.candidate.setPose(neutral);
    const origin = captureSemanticTransforms(input.candidate.root);
    const samples = [
      { id: "yaw-negative", pose: { turretYaw: -0.6, gunElevation: 0 }, moving: turretOwned, stationary: allSemantics.filter((id) => !turretOwned.includes(id)) },
      { id: "yaw-large", pose: { turretYaw: 2.2, gunElevation: 0 }, moving: turretOwned, stationary: allSemantics.filter((id) => !turretOwned.includes(id)) },
      { id: "depression", pose: { turretYaw: 0, gunElevation: -0.18 }, moving: gunOwned, stationary: allSemantics.filter((id) => !gunOwned.includes(id)) },
      { id: "elevation", pose: { turretYaw: 0, gunElevation: 0.3 }, moving: gunOwned, stationary: allSemantics.filter((id) => !gunOwned.includes(id)) },
      { id: "combined", pose: { turretYaw: 0.6, gunElevation: 0.25 }, moving: turretOwned, stationary: allSemantics.filter((id) => !turretOwned.includes(id)) },
    ];
    for (const sample of samples) {
      try {
        await input.candidate.setPose(sample.pose);
        const result = checkArticulation(origin, captureSemanticTransforms(input.candidate.root), { moving: sample.moving, stationary: sample.stationary, epsilon: 1e-8 });
        rows.push({ code: `articulation.pose.${sample.id}`, phase: "fittings-articulation", component: "articulation", passed: result.passed, score: result.passed ? 100 : 0, severity: "critical", message: result.passed ? `${sample.id} moves only owned components` : `${sample.id} failed: ${result.rows.filter((row) => !row.passed).map((row) => `${row.semanticId} ${row.expected}`).join(", ")}` });
      } catch (error) {
        rows.push({ code: `articulation.pose.${sample.id}`, phase: "fittings-articulation", component: "articulation", passed: false, score: 0, severity: "critical", message: `pose control failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    await input.candidate.setPose(neutral);
  }
  const articulation: GateReport = { profile: input.profile, passed: rows.every((row) => row.passed), score: rows.length ? Math.min(...rows.map((row) => row.score)) : 100, rows, workorders: [] };
  const contractGates = evaluateProfileContractGates(getProfileContract(input.profile), { deterministic: base.deterministic.rows, articulation: articulation.rows });
  return { ...base, articulation, contractGates, passed: base.deterministic.passed && base.style.passed && articulation.passed && contractGates.passed };
}

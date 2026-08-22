import type * as THREE from "three";
import type { GateReport, ProfileId } from "../types.js";
import { snapshotScene } from "./geometry.js";
import { fingerprintSnapshot } from "./hashing.js";
import { evaluateGenericPoseRows, evaluateGenericProfile, type GenericSubjectContract } from "../profiles/generic.js";
import { evaluateTankPoseRows, evaluateTankProfile } from "../profiles/tank.js";
import { evaluateLowPolyStyle, lowPolyFaithful, type StyleContract } from "../styles/low-poly.js";
import { captureSemanticTransforms, checkArticulation } from "./measurement.js";
import type { CandidateRuntime, GateRow } from "../types.js";
import { composeCandidateHash } from "./candidate.js";
import { canonicalJson, sha256 } from "./hashing.js";
import { evaluateProfileContractGates, getProfileContract } from "./contracts.js";
import type { PerformanceRecorder } from "./performance.js";

export interface EvaluationBundle {
  oracleHash: string;
  candidateHash: string;
  deterministic: GateReport;
  style: GateReport;
  contractGates: GateReport;
  phaseGates: Record<string, GateReport>;
  passed: boolean;
  phaseGeometryHashes: Record<string, string>;
}

function splitContractGatesByPhase(profile: ProfileId, report: GateReport): Record<string, GateReport> {
  const result: Record<string, GateReport> = {};
  for (const phase of getProfileContract(profile).phases) {
    const rows = report.rows.filter((row) => row.phase === phase.id);
    if (!rows.length) continue;
    result[phase.id] = {
      profile,
      passed: rows.every((row) => row.passed),
      score: Math.min(...rows.map((row) => row.score)),
      rows,
      workorders: report.workorders.filter((workorder) => workorder.phase === phase.id),
    };
  }
  return result;
}

function phaseGeometryHashes(profile: ProfileId, snapshot: ReturnType<typeof snapshotScene>, subjectContract?: GenericSubjectContract, candidateSourceHash?: string): Record<string, string> {
  const ids = Object.values(snapshot.components);
  const matching = (predicate: (id: string, role?: string) => boolean): ReadonlySet<string> => new Set(ids.filter((component) => predicate(component.id, component.role)).map((component) => component.id));
  if (profile === "tank") {
    const fittingsGeometry = fingerprintSnapshot(snapshot, undefined, { includeMaterials: false });
    return {
    hull: fingerprintSnapshot(snapshot, matching((id) => id.startsWith("hull")), { includeMaterials: false }),
    turret: fingerprintSnapshot(snapshot, matching((id) => id === "turret" || id === "turret-pivot" || id === "cupola"), { includeMaterials: false }),
    gun: fingerprintSnapshot(snapshot, matching((id) => id === "gun" || id === "gun-pivot"), { includeMaterials: false }),
    "running-gear": fingerprintSnapshot(snapshot, matching((id, role) => ["road-wheel", "sprocket", "idler", "return-roller"].includes(role ?? "") || /^(road-wheel|sprocket|idler|return-roller)-/u.test(id)), { includeMaterials: false }),
    tracks: fingerprintSnapshot(snapshot, matching((id, role) => role === "track-course" || id.startsWith("track-")), { includeMaterials: false }),
    "fittings-articulation": candidateSourceHash ? sha256(canonicalJson({ geometryHash: fittingsGeometry, candidateSourceHash, articulation: getProfileContract("tank").articulation })) : fittingsGeometry,
    "style-fabrication": fingerprintSnapshot(snapshot),
    "visual-review": fingerprintSnapshot(snapshot),
    };
  }
  const owned = (phase: "primary-mass" | "attachments" | "identity-features", fallback: (component: (typeof ids)[number]) => boolean): ReadonlySet<string> => {
    const declared = subjectContract?.phaseOwnership?.[phase];
    return new Set((declared?.length ? ids.filter((component) => declared.includes(component.id)) : ids.filter(fallback)).map((component) => component.id));
  };
  const genericSemantics = getProfileContract("generic").semantics;
  const attachmentsGeometry = fingerprintSnapshot(snapshot, owned("attachments", (component) => genericSemantics.optional.includes(component.id) || Boolean(component.parentSemanticId) || component.role === "attachment"), { includeMaterials: false });
  return {
    "primary-mass": fingerprintSnapshot(snapshot, owned("primary-mass", (component) => genericSemantics.required.includes(component.id) || component.role === "primary-mass"), { includeMaterials: false }),
    attachments: candidateSourceHash && subjectContract?.articulation?.length ? sha256(canonicalJson({ geometryHash: attachmentsGeometry, candidateSourceHash, articulation: subjectContract.articulation })) : attachmentsGeometry,
    "identity-features": fingerprintSnapshot(snapshot, owned("identity-features", (component) => component.critical || component.role === "identity-feature"), { includeMaterials: false }),
    "style-complexity": fingerprintSnapshot(snapshot),
    "visual-review": fingerprintSnapshot(snapshot),
  };
}

export interface PosedEvaluationBundle extends EvaluationBundle {
  articulation: GateReport;
}

function evaluateSnapshots(input: Parameters<typeof evaluateCandidate>[0], oracleSnapshot: ReturnType<typeof snapshotScene>, candidateSnapshot: ReturnType<typeof snapshotScene>): EvaluationBundle {
  const deterministic = input.profile === "tank"
    ? evaluateTankProfile(oracleSnapshot, candidateSnapshot, {
        certification: input.certification ?? "oracle-relative",
        ...(input.authoritativeDimensions ? { authoritativeDimensions: input.authoritativeDimensions as { hullLength: number; overallLength: number; width: number; height: number } } : {}),
        ...(input.performance ? { performance: input.performance } : {}),
      })
    : evaluateGenericProfile(oracleSnapshot, candidateSnapshot, input.subjectContract, {
        certification: input.certification ?? "oracle-relative",
        ...(input.authoritativeDimensions && ["width", "height", "depth"].every((key) => Number.isFinite(input.authoritativeDimensions![key])) ? { authoritativeDimensions: input.authoritativeDimensions as { width: number; height: number; depth: number } } : {}),
      });
  const stylePhase = input.profile === "tank" ? "style-fabrication" : "style-complexity";
  const style = input.performance?.measure("neutral-style-evaluation", () => evaluateLowPolyStyle(oracleSnapshot, candidateSnapshot, input.style ?? lowPolyFaithful, stylePhase)) ?? evaluateLowPolyStyle(oracleSnapshot, candidateSnapshot, input.style ?? lowPolyFaithful, stylePhase);
  const contractGates = evaluateProfileContractGates(getProfileContract(input.profile), { deterministic: deterministic.rows, style: style.rows });
  return {
    oracleHash: fingerprintSnapshot(oracleSnapshot),
    candidateHash: input.candidateSourceHash ? composeCandidateHash(input.candidateNeutralHash ?? fingerprintSnapshot(candidateSnapshot), input.candidateSourceHash) : fingerprintSnapshot(candidateSnapshot),
    deterministic, style, contractGates,
    phaseGates: splitContractGatesByPhase(input.profile, contractGates),
    passed: deterministic.passed && style.passed && contractGates.passed,
    phaseGeometryHashes: phaseGeometryHashes(input.profile, candidateSnapshot, input.subjectContract, input.candidateSourceHash),
  };
}

export function evaluateCandidate(input: {
  oracle: THREE.Object3D;
  candidate: THREE.Object3D;
  profile: ProfileId;
  style?: StyleContract;
  authoritativeDimensions?: Record<string, number>;
  certification?: "exact-real" | "oracle-relative";
  subjectContract?: GenericSubjectContract;
  candidateSourceHash?: string;
  candidateNeutralHash?: string;
  performance?: PerformanceRecorder;
}): EvaluationBundle {
  const oracleSnapshot = input.performance?.measure("oracle-snapshot-construction", () => snapshotScene(input.oracle)) ?? snapshotScene(input.oracle);
  const candidateSnapshot = input.performance?.measure("candidate-snapshot-construction", () => snapshotScene(input.candidate)) ?? snapshotScene(input.candidate);
  return evaluateSnapshots(input, oracleSnapshot, candidateSnapshot);
}

export async function evaluateCandidateWithPoses(input: Omit<Parameters<typeof evaluateCandidate>[0], "candidate"> & { candidate: CandidateRuntime }): Promise<PosedEvaluationBundle> {
  const evaluationInput = { ...input, candidate: input.candidate.root, ...(input.candidate.sourceHash ? { candidateSourceHash: input.candidate.sourceHash } : {}) };
  const oracleSnapshot = input.performance?.measure("oracle-snapshot-construction", () => snapshotScene(input.oracle)) ?? snapshotScene(input.oracle);
  const candidateSnapshot = input.performance?.measure("candidate-snapshot-construction", () => snapshotScene(input.candidate.root)) ?? snapshotScene(input.candidate.root);
  const base = evaluateSnapshots(evaluationInput, oracleSnapshot, candidateSnapshot);
  const rows: GateRow[] = [];
  const profileContract = getProfileContract(input.profile);
  const controls = input.profile === "generic" ? input.subjectContract?.articulation ?? [] : profileContract.articulation;
  const articulationPhase = profileContract.gates.find((gate) => gate.code === "articulation.poses")?.phase ?? "attachments";
  if (controls.length) {
    const semanticSnapshot = snapshotScene(input.candidate.root);
    const allSemantics = Object.keys(semanticSnapshot.components);
    const neutral = Object.fromEntries(controls.map((control) => [control.control, 0]));
    await input.candidate.setPose(neutral);
    const origin = captureSemanticTransforms(input.candidate.root);
    try {
      for (const control of controls) {
        for (const [sampleIndex, value] of control.samples.entries()) {
          if (Math.abs(value) <= 1e-12) continue;
          const pose = { ...neutral, [control.control]: value };
          const code = `articulation.pose.${control.control}.${sampleIndex}`;
          const poseStarted = input.performance?.start();
          try {
            await input.candidate.setPose(neutral);
            await input.candidate.setPose(pose);
            const moving = allSemantics.filter((id) => {
              let current = semanticSnapshot.components[id];
              while (current) {
                if (control.moving.includes(current.id)) return true;
                current = current.parentSemanticId ? semanticSnapshot.components[current.parentSemanticId] : undefined;
              }
              return false;
            });
            const stationary = [...new Set([...control.stationary, ...allSemantics.filter((id) => !moving.includes(id))])];
            const transformResult = checkArticulation(origin, captureSemanticTransforms(input.candidate.root), { moving, stationary, epsilon: 1e-8 });
            const posedSnapshot = snapshotScene(input.candidate.root);
            const spatialRows = input.profile === "tank" ? evaluateTankPoseRows(oracleSnapshot, posedSnapshot) : evaluateGenericPoseRows(oracleSnapshot, posedSnapshot, input.subjectContract);
            const passed = transformResult.passed && spatialRows.every((row) => row.passed);
            const failures = [
              ...transformResult.rows.filter((row) => !row.passed).map((row) => `${row.semanticId} ${row.expected}`),
              ...spatialRows.filter((row) => !row.passed).map((row) => row.code),
            ];
            rows.push({ code, phase: articulationPhase, component: control.control, passed, score: passed ? 100 : 0, severity: "critical", message: passed ? `${control.control}=${value} moves only owned, seated components` : `${control.control}=${value} failed: ${failures.join(", ")}` });
          } catch (error) {
            rows.push({ code, phase: articulationPhase, component: control.control, passed: false, score: 0, severity: "critical", message: `pose control failed: ${error instanceof Error ? error.message : String(error)}` });
          } finally {
            if (poseStarted) input.performance!.recordSince(`articulation.${control.control}.sample-${sampleIndex}`, poseStarted);
          }
        }
      }
    } finally {
      await input.candidate.setPose(neutral);
    }
  }
  const articulation: GateReport = { profile: input.profile, passed: rows.every((row) => row.passed), score: rows.length ? Math.min(...rows.map((row) => row.score)) : 100, rows, workorders: [] };
  const contractGates = evaluateProfileContractGates(getProfileContract(input.profile), { deterministic: base.deterministic.rows, articulation: articulation.rows, style: base.style.rows });
  const phaseGates = splitContractGatesByPhase(input.profile, contractGates);
  if (input.profile === "generic" && controls.length) {
    const current = phaseGates[articulationPhase] ?? { profile: input.profile, passed: true, score: 100, rows: [], workorders: [] };
    phaseGates[articulationPhase] = { ...current, passed: current.passed && articulation.passed, score: Math.min(current.score, articulation.score), rows: [...current.rows, ...articulation.rows] };
  }
  return { ...base, articulation, contractGates, phaseGates, passed: base.deterministic.passed && base.style.passed && articulation.passed && contractGates.passed };
}

export function neutralPoseForProfile(profile: ProfileId, subjectContract?: GenericSubjectContract): Record<string, number> {
  const controls = profile === "generic" ? subjectContract?.articulation ?? [] : getProfileContract(profile).articulation;
  return Object.fromEntries(controls.map((control) => [control.control, 0]));
}

import * as THREE from "three";
import { createTrackCourseGeometry } from "../src/kit.js";
import { evaluateCandidateWithPoses } from "../src/core/orchestration.js";
import { checkWatertightness, measureSection } from "../src/core/measurement.js";
import { snapshotScene } from "../src/core/geometry.js";
import { fingerprintSnapshot } from "../src/core/hashing.js";
import { PerformanceRecorder } from "../src/core/performance.js";

/**
 * Multi-component hard-surface stress workload: a tank-like multipart hierarchy large enough to
 * expose accidental quadratic behavior, avoidable copies, and runaway operators before the first
 * real reconstruction run. Exercises hull stations/sections, silhouette curves, watertightness and
 * connectivity, repeated running-gear instances, track-course diagnostics, and pose articulation
 * sampling at roughly the scale of a detailed CAD export.
 */

const scale = Number(process.env.MESH2THREEJS_BENCH_STRESS_SCALE ?? 1);
if (!Number.isFinite(scale) || scale <= 0) throw new Error("MESH2THREEJS_BENCH_STRESS_SCALE must be a positive number");
const density = (base: number): number => Math.max(4, Math.round(base * scale));

function semanticMesh(id: string, geometry: THREE.BufferGeometry, position: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x66705a, roughness: 0.72 }));
  mesh.name = id;
  mesh.userData.semanticId = id;
  mesh.position.set(...position);
  return mesh;
}

function buildStressTank(): THREE.Group {
  const root = new THREE.Group();
  root.name = "stress-tank";
  root.userData.forwardAxis = "+z";
  const hull = semanticMesh("hull", new THREE.CylinderGeometry(1.6, 1.8, 6, density(512), density(192)), [0, 1.15, 0]);
  hull.rotation.x = Math.PI / 2;
  hull.scale.set(1, 1, 0.35);
  root.add(hull);
  const upper = semanticMesh("hull-upper", new THREE.BoxGeometry(2.8, 0.6, 3.8, density(64), density(16), density(96)), [0, 1.85, -0.2]);
  root.add(upper);
  const turretPivot = new THREE.Group();
  turretPivot.name = "turret-pivot";
  turretPivot.userData.semanticId = "turret-pivot";
  turretPivot.position.set(0, 2.4, -0.25);
  const turret = semanticMesh("turret", new THREE.SphereGeometry(1.2, density(256), density(128)), [0, 0, 0]);
  turret.scale.set(1, 0.55, 1.2);
  turretPivot.add(turret);
  const gunPivot = new THREE.Group();
  gunPivot.name = "gun-pivot";
  gunPivot.userData.semanticId = "gun-pivot";
  gunPivot.position.set(0, 0.05, 0.8);
  const gun = semanticMesh("gun", new THREE.CylinderGeometry(0.12, 0.12, 3.4, density(64), density(8)), [0, 0, 1.7]);
  gun.rotation.x = Math.PI / 2;
  gunPivot.add(gun);
  turretPivot.add(gunPivot);
  turretPivot.add(semanticMesh("cupola", new THREE.CylinderGeometry(0.35, 0.4, 0.35, density(24), 2), [0.35, 0.55, -0.1]));
  root.add(turretPivot);
  for (const side of [-1, 1] as const) {
    for (let index = 0; index < 5; index += 1) {
      const wheel = semanticMesh(`road-wheel-${side}-${index}`, new THREE.CylinderGeometry(0.55, 0.55, 0.22, density(96), density(6)), [side * 1.55, 0.6, -2 + index]);
      wheel.rotation.z = Math.PI / 2;
      wheel.userData.semanticRole = "road-wheel";
      root.add(wheel);
    }
    const track = semanticMesh(`track-${side}`, createTrackCourseGeometry(5.5, 1.25, 0.25, 0.35), [side * 1.7, 0.05, 0]);
    track.userData.semanticRole = "track-course";
    root.add(track);
  }
  root.updateMatrixWorld(true);
  return root;
}

const performance = new PerformanceRecorder();
const oracleScene = buildStressTank();
const candidateScene = buildStressTank();
const oracleSnapshot = performance.measure("oracle-snapshot-construction", () => snapshotScene(oracleScene));
const candidateSnapshot = performance.measure("candidate-snapshot-construction", () => snapshotScene(candidateScene));

const evaluation = await evaluateCandidateWithPoses({
  oracle: oracleScene,
  candidate: {
    root: candidateScene,
    sourceHash: "stress-candidate-source",
    setPose: (pose) => {
      const turret = candidateScene.getObjectByName("turret-pivot");
      const gun = candidateScene.getObjectByName("gun-pivot");
      if (turret) turret.rotation.y = pose.turretYaw ?? 0;
      if (gun) gun.rotation.x = pose.gunElevation ?? 0;
    },
  },
  profile: "tank",
  performance,
});

performance.measure("hull-watertightness-explicit", () => checkWatertightness(candidateSnapshot, ["hull", "hull-upper", "turret"]));
const hullBounds = oracleSnapshot.components.hull!.bounds;
for (let index = 0; index < 14; index += 1) {
  const positionZ = hullBounds.min[2] + hullBounds.size[2] * ((index + 0.5) / 14);
  performance.measure(`explicit-section-${String(index).padStart(2, "0")}`, () => measureSection(candidateSnapshot, { axis: "z", position: positionZ, thickness: hullBounds.size[2] / 140, semanticIds: ["hull", "hull-upper"] }));
}
const fingerprint = performance.measure("candidate-fingerprint", () => fingerprintSnapshot(candidateSnapshot));

const report = performance.report();
const dominant = [...report.operators].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 12);
const oracleSnapshotMs = report.operators.filter((row) => row.operator === "oracle-snapshot-construction").reduce((sum, row) => sum + row.elapsedMs, 0);
const poseEvalMs = report.operators.filter((row) => row.operator.startsWith("articulation.")).reduce((sum, row) => sum + row.elapsedMs, 0);
const totalEvalMs = report.operators.reduce((sum, row) => sum + row.elapsedMs, 0);
const result = {
  workload: "multi-component hard-surface stress: hull stations, silhouettes, watertightness, repeats, tracks, articulation",
  stressScale: scale,
  oracleTriangles: oracleSnapshot.triangleCount,
  candidateTriangles: candidateSnapshot.triangleCount,
  evaluationPassed: evaluation.passed,
  deterministicPassed: evaluation.deterministic.passed,
  articulationPassed: evaluation.articulation.passed,
  contractPassed: evaluation.contractGates.passed,
  stylePassed: evaluation.style.passed,
  styleSegmentPolicyNote: "synthetic dense primitives intentionally exceed the authored-candidate segment budget; the low-poly style contract rejects them by design, while every geometry/articulation/contract operator completes",
  failingDeterministicRows: evaluation.deterministic.rows.filter((row) => !row.passed).map((row) => ({ code: row.code, message: row.message })),
  failingArticulationRows: evaluation.articulation.rows.filter((row) => !row.passed).map((row) => ({ code: row.code, message: row.message })),
  fingerprintPrefix: fingerprint.slice(0, 12),
  cacheEvidence: {
    oracleSnapshotMs,
    candidateIterationCostMs: totalEvalMs - oracleSnapshotMs,
    oracleShareOfGate: oracleSnapshotMs / totalEvalMs,
    poseSamplingMs: poseEvalMs,
  },
  dominantOperators: dominant,
  ...report,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
const rssCeiling = 12 * 1024 ** 3;
if (totalEvalMs > 600_000) throw new Error(`hard-surface stress evaluation exceeded 600s ceiling: ${totalEvalMs.toFixed(1)}ms`);
if (report.peakObservedRssBytes > rssCeiling) throw new Error(`hard-surface stress evaluation exceeded 12 GiB observed RSS ceiling: ${(report.peakObservedRssBytes / 1024 ** 3).toFixed(2)} GiB`);

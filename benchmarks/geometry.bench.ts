import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { analyticalTank } from "../src/fixtures/analytical.js";
import { evaluateProfileContractGates, getProfileContract } from "../src/core/contracts.js";
import { snapshotScene } from "../src/core/geometry.js";
import { fingerprintSnapshot } from "../src/core/hashing.js";
import { evaluateCandidateWithPoses } from "../src/core/orchestration.js";
import { loadPreparedOracle, onboardOracle } from "../src/core/oracle.js";
import { PerformanceRecorder } from "../src/core/performance.js";
import { deriveCanonicalFrame, rasterizeCapture, standardRenderProfile } from "../src/core/render.js";
import { evaluateGenericProfile } from "../src/profiles/generic.js";
import { evaluateLowPolyStyle, lowPolyFaithful } from "../src/styles/low-poly.js";

function minimalGlb(): Buffer {
  const positions = new Float32Array([-1, 0, -1, 1, 0, -1, 0, 1, -1]);
  const binary = Buffer.from(positions.buffer);
  const document = { asset: { version: "2.0" }, buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, 0, -1], max: [1, 1, -1] }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0, name: "Object_0" }], scenes: [{ nodes: [0] }], scene: 0 };
  let json = Buffer.from(JSON.stringify(document));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const bin = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
  const output = Buffer.alloc(12 + 8 + json.length + 8 + bin.length);
  output.write("glTF", 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8); output.writeUInt32LE(json.length, 12); output.writeUInt32LE(0x4e4f534a, 16); json.copy(output, 20);
  const offset = 20 + json.length; output.writeUInt32LE(bin.length, offset); output.writeUInt32LE(0x004e4942, offset + 4); bin.copy(output, offset + 8);
  return output;
}

const performance = new PerformanceRecorder();
const temporary = await mkdtemp(join(tmpdir(), "mesh2threejs-benchmark-"));
try {
  const sourcePath = join(temporary, "source.glb");
  const preparedPath = join(temporary, "prepared.json");
  await writeFile(sourcePath, minimalGlb());
  const manifest = await performance.measureAsync("glb-load-preparation", () => onboardOracle({ id: "benchmark", sourcePath, preparedPath, source: "generated analytical benchmark", author: "mesh2threejs", license: "generated fixture", redistribution: "allowed", coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1, semanticMap: { "node:0": "primary" }, articulationMap: {}, normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 }, authoritativeDimensions: null, dimensionSources: [] }));
  await performance.measureAsync("prepared-oracle-load", () => loadPreparedOracle(manifest));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const oracle = analyticalTank();
const candidate = analyticalTank();
await evaluateCandidateWithPoses({ oracle, candidate: { root: candidate, sourceHash: "benchmark-source", setPose: (pose) => {
  const turret = candidate.getObjectByName("turret-pivot"); const gun = candidate.getObjectByName("gun-pivot");
  if (turret) turret.rotation.y = pose.turretYaw ?? 0;
  if (gun) gun.rotation.x = pose.gunElevation ?? 0;
} }, profile: "tank", performance });

const syntheticTriangles = Number(process.env.MESH2THREEJS_BENCH_TRIANGLES ?? 3_500_000);
if (!Number.isInteger(syntheticTriangles) || syntheticTriangles < 1) throw new Error("MESH2THREEJS_BENCH_TRIANGLES must be a positive integer");
const syntheticPositions = new Float32Array(syntheticTriangles * 9);
for (let triangle = 0; triangle < syntheticTriangles; triangle += 1) {
  const offset = triangle * 9; const x = triangle % 1024; const z = Math.floor(triangle / 1024) % 1024;
  syntheticPositions.set([x, 0, z, x + 0.5, 0, z, x, 0, z + 0.5], offset);
}
const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(syntheticPositions, 3));
const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x778866, roughness: 0.7, flatShading: true })); mesh.userData.semanticId = "primary";
const largeSnapshot = performance.measure("cad-snapshot-construction", () => snapshotScene(mesh));
const largeFingerprint = performance.measure("cad-fingerprinting", () => fingerprintSnapshot(largeSnapshot, undefined, { includeMaterials: false }));
const generic = performance.measure("cad-complete-deterministic-evaluator", () => evaluateGenericProfile(largeSnapshot, largeSnapshot));
const style = performance.measure("cad-neutral-style-evaluation", () => evaluateLowPolyStyle(largeSnapshot, largeSnapshot, lowPolyFaithful, "style-complexity"));
const contract = performance.measure("cad-contract-evaluation", () => evaluateProfileContractGates(getProfileContract("generic"), { deterministic: generic.rows, style: style.rows }));
const frame = deriveCanonicalFrame(largeSnapshot.components.primary!.bounds, 1);
const renderProfile = standardRenderProfile({ width: 64, height: 64 }); renderProfile.camera.orthographicHeight = frame.orthographicHeight;
renderProfile.camera.far = Math.max(renderProfile.camera.far, frame.orthographicHeight * 4);
const largeFrame = performance.measure("visual-render-preparation", () => rasterizeCapture(largeSnapshot, renderProfile, frame.cameras.plan, "alpha-silhouette"));
const report = performance.report();
let coveredPixels = 0;
for (let offset = 3; offset < largeFrame.data.length; offset += 4) if ((largeFrame.data[offset] ?? 0) > 0) coveredPixels += 1;
const result = {
  workload: "analytical operators plus CAD-scale synthetic complete generic evaluator",
  syntheticTriangles,
  snapshotBytes: largeSnapshot.triangleData.positions.byteLength + largeSnapshot.triangleData.normals.byteLength + largeSnapshot.triangleData.componentIndices.byteLength + largeSnapshot.triangleData.materialIndices.byteLength + largeSnapshot.triangleData.colors.byteLength + largeSnapshot.triangleData.roughness.byteLength,
  fingerprintPrefix: largeFingerprint.slice(0, 12),
  evaluatorCompleted: true,
  evaluationResult: { deterministicPassed: generic.passed, stylePassed: style.passed, contractPassed: contract.passed },
  coveredPixels,
  ...report,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
const cadElapsed = report.operators.filter((row) => row.operator.startsWith("cad-") || row.operator === "visual-render-preparation").reduce((sum, row) => sum + row.elapsedMs, 0);
const rssCeiling = 2.5 * 1024 ** 3;
if (cadElapsed > 180_000) throw new Error(`CAD-scale evaluator exceeded 180s ceiling: ${cadElapsed.toFixed(1)}ms`);
if (report.peakObservedRssBytes > rssCeiling) throw new Error(`CAD-scale evaluator exceeded 2.5 GiB observed RSS ceiling: ${(report.peakObservedRssBytes / 1024 ** 3).toFixed(2)} GiB`);

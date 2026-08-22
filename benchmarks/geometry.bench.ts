import { performance } from "node:perf_hooks";
import * as THREE from "three";
import { analyticalTank } from "../src/fixtures/analytical.js";
import { snapshotScene } from "../src/core/geometry.js";
import { rasterizeCapture, standardRenderProfile } from "../src/core/render.js";
import { measureBounds } from "../src/core/measurement.js";
import { fingerprintSnapshot } from "../src/core/hashing.js";

const snapshot = snapshotScene(analyticalTank());
const profile = standardRenderProfile({ width: 128, height: 128 });
const camera = { id: "bench", projection: "orthographic" as const, position: [12, 3, 0] as const, target: [0, 0.8, 0] as const };
const iterations = 12;
const started = performance.now();
let coveredPixels = 0;
for (let index = 0; index < iterations; index += 1) {
  const frame = rasterizeCapture(snapshot, profile, camera, "alpha-silhouette");
  for (let offset = 3; offset < frame.data.length; offset += 4) if ((frame.data[offset] ?? 0) > 0) coveredPixels += 1;
}
const elapsedMs = performance.now() - started;
const syntheticTriangles = Number(process.env.MESH2THREEJS_BENCH_TRIANGLES ?? 3_500_000);
if (!Number.isInteger(syntheticTriangles) || syntheticTriangles < 1) throw new Error("MESH2THREEJS_BENCH_TRIANGLES must be a positive integer");
const syntheticPositions = new Float32Array(syntheticTriangles * 9);
for (let triangle = 0; triangle < syntheticTriangles; triangle += 1) {
  const offset = triangle * 9;
  const x = triangle % 1024;
  const z = Math.floor(triangle / 1024) % 1024;
  syntheticPositions[offset] = x; syntheticPositions[offset + 1] = 0; syntheticPositions[offset + 2] = z;
  syntheticPositions[offset + 3] = x + 0.5; syntheticPositions[offset + 4] = 0; syntheticPositions[offset + 5] = z;
  syntheticPositions[offset + 6] = x; syntheticPositions[offset + 7] = 0; syntheticPositions[offset + 8] = z + 0.5;
}
const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.BufferAttribute(syntheticPositions, 3));
const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x778866, roughness: 0.7 }));
mesh.userData.semanticId = "synthetic-mass";
const largeStarted = performance.now();
const largeSnapshot = snapshotScene(mesh);
const largeBounds = measureBounds(largeSnapshot);
const largeFingerprint = fingerprintSnapshot(largeSnapshot, undefined, { includeMaterials: false });
const largeElapsedMs = performance.now() - largeStarted;
const largeProfile = standardRenderProfile({ width: 64, height: 64 });
largeProfile.camera.orthographicHeight = 1_150;
const largeCaptureStarted = performance.now();
const largeFrame = rasterizeCapture(largeSnapshot, largeProfile, { id: "large-plan", projection: "orthographic", position: [512, 100, 512], target: [512, 0, 512] }, "alpha-silhouette");
const largeCaptureElapsedMs = performance.now() - largeCaptureStarted;
let largeCoveredPixels = 0;
for (let offset = 3; offset < largeFrame.data.length; offset += 4) if ((largeFrame.data[offset] ?? 0) > 0) largeCoveredPixels += 1;
const result = {
  fixtureTriangles: snapshot.triangleCount,
  resolution: [profile.renderer.width, profile.renderer.height],
  iterations,
  elapsedMs: Number(elapsedMs.toFixed(2)),
  capturesPerSecond: Number(((iterations / elapsedMs) * 1000).toFixed(2)),
  coveredPixels,
  synthetic: {
    triangles: syntheticTriangles,
    elapsedMs: Number(largeElapsedMs.toFixed(2)),
    captureElapsedMs: Number(largeCaptureElapsedMs.toFixed(2)),
    coveredPixels: largeCoveredPixels,
    bounds: largeBounds.size,
    fingerprintPrefix: largeFingerprint.slice(0, 12),
    snapshotBytes: largeSnapshot.triangleData.positions.byteLength + largeSnapshot.triangleData.normals.byteLength + largeSnapshot.triangleData.componentIndices.byteLength + largeSnapshot.triangleData.materialIndices.byteLength + largeSnapshot.triangleData.colors.byteLength + largeSnapshot.triangleData.roughness.byteLength,
    residentSetMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
  },
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (elapsedMs > 15_000) throw new Error(`geometry benchmark exceeded 15s ceiling: ${elapsedMs.toFixed(1)}ms`);
if (largeElapsedMs > 60_000) throw new Error(`large-scene benchmark exceeded 60s ceiling: ${largeElapsedMs.toFixed(1)}ms`);
if (largeCaptureElapsedMs > 60_000) throw new Error(`large-scene capture benchmark exceeded 60s ceiling: ${largeCaptureElapsedMs.toFixed(1)}ms`);

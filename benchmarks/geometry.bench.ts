import { performance } from "node:perf_hooks";
import { analyticalTank } from "../src/fixtures/analytical.js";
import { snapshotScene } from "../src/core/geometry.js";
import { rasterizeCapture, standardRenderProfile } from "../src/core/render.js";

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
const result = {
  fixtureTriangles: snapshot.triangleCount,
  resolution: [profile.renderer.width, profile.renderer.height],
  iterations,
  elapsedMs: Number(elapsedMs.toFixed(2)),
  capturesPerSecond: Number(((iterations / elapsedMs) * 1000).toFixed(2)),
  coveredPixels,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (elapsedMs > 15_000) throw new Error(`geometry benchmark exceeded 15s ceiling: ${elapsedMs.toFixed(1)}ms`);

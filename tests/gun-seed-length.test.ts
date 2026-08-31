import { describe, expect, it } from "vitest";
import { buildGunSeed } from "../src/core/derive.js";
import type { SceneSnapshot } from "../src/types.js";

/** Synthetic oracle: gun mesh heavily asymmetric about its bounds center (breach mass at the
 * pivot side), so center×2 length is materially shorter than the true muzzle distance. */
function asymmetricGunSnapshot(): SceneSnapshot {
  const positions: number[] = [];
  const push = (x: number, y: number, z: number): void => { positions.push(x, y, z); };
  // barrel: thin box from the pivot (origin) extending to x = 4.0
  const y0 = -0.05, y1 = 0.05, z0 = -0.05, z1 = 0.05;
  const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]): void => {
    push(...a); push(...b); push(...c);
    push(...a); push(...c); push(...d);
  };
  for (let x = 0; x < 4; x += 0.5) {
    const xn = Math.min(x + 0.5, 4);
    quad([x, y0, z0], [xn, y0, z0], [xn, y1, z0], [x, y1, z0]);
    quad([x, y1, z1], [xn, y1, z1], [xn, y0, z1], [x, y0, z1]);
    quad([x, y0, z1], [xn, y0, z1], [xn, y0, z0], [x, y0, z0]);
    quad([x, y1, z0], [xn, y1, z0], [xn, y1, z1], [x, y1, z1]);
  }
  // breach: dense mass near the pivot side (x in [0, 0.5]) that pulls the bounds center toward it
  for (let x = 0; x < 0.5; x += 0.1) {
    const xn = x + 0.1;
    quad([x, -0.3, -0.3], [xn, -0.3, -0.3], [xn, 0.3, -0.3], [x, 0.3, -0.3]);
    quad([x, 0.3, 0.3], [xn, 0.3, 0.3], [xn, -0.3, 0.3], [x, -0.3, 0.3]);
    quad([x, -0.3, 0.3], [xn, -0.3, 0.3], [xn, -0.3, -0.3], [x, -0.3, -0.3]);
    quad([x, 0.3, -0.3], [xn, 0.3, -0.3], [xn, 0.3, 0.3], [x, 0.3, 0.3]);
    quad([x, -0.3, -0.3], [x, 0.3, -0.3], [x, 0.3, 0.3], [x, -0.3, 0.3]);
    quad([xn, -0.3, -0.3], [xn, -0.3, 0.3], [xn, 0.3, 0.3], [xn, 0.3, -0.3]);
  }
  // muzzle tip cap at x = 4.0
  quad([4, -0.05, -0.05], [4, 0.05, -0.05], [4, 0.05, 0.05], [4, -0.05, 0.05]);

  const triangleData = { positions: new Float32Array(positions) };
  const triangleIndices = Array.from({ length: positions.length / 9 }, (_, i) => i);
  // bounds center: barrel spans [0,4], breach spans y/z [-0.3,0.3] near x<0.5
  // => center ≈ (2.0, 0, 0); centerDistance×2 = 4.0 — but with heavier breach geometry the
  // point-cloud center of mass is nearer the pivot; bounds center stays (2,0,0) here, so also
  // shift the barrel start to x = 0.6 (gun mesh does not include the breach volume behind it)
  return {
    components: {
      gun: { id: "gun", semanticId: "gun", role: "gun", parentSemanticId: "gun-pivot", triangleIndices, bounds: { min: [0, -0.3, -0.3], max: [4, 0.3, 0.3], center: [1.4, 0, 0], size: [4, 0.6, 0.6] } },
      "gun-pivot": { id: "gun-pivot", semanticId: "gun-pivot", role: "gun-pivot", parentSemanticId: "turret", triangleIndices: [], bounds: { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], size: [0, 0, 0] }, origin: [0, 0, 0] },
    },
    triangleData,
  } as unknown as SceneSnapshot;
}

describe("axis-fit gun seed length", () => {
  it("spans the real muzzle distance even when the mesh is asymmetric about its bounds center", () => {
    const snapshot = asymmetricGunSnapshot();
    const seed = buildGunSeed(snapshot, new Set());
    const gun = seed.nodes.find((node) => node.semanticId === "gun");
    expect(gun).toBeTruthy();
    const positions = gun!.positions as Float32Array;
    let maxDistance = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const distance = Math.hypot(positions[i]!, positions[i + 1]!, positions[i + 2]!);
      if (distance > maxDistance) maxDistance = distance;
    }
    // oracle muzzle distance: the farthest gun vertex from the pivot = 4.0 (the muzzle tip);
    // the bounds center is (1.4, 0, 0) so a center×2 length would only be 2.8 (a 30% error).
    expect(maxDistance).toBeGreaterThan(3.9);
    expect(maxDistance).toBeLessThan(4.05);
  });
});

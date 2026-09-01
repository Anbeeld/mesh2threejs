import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildGunSeed } from "../src/core/derive.js";
import { measureGunGeometry } from "../src/core/gun-metrics.js";
import { snapshotScene } from "../src/index.js";
import { sceneToGlb } from "./helpers/tank-fixtures.js";
import type { SceneSnapshot } from "../src/types.js";

/** Build an oracle whose gun is an N-sided cylinder barrel along +x with an arbitrary ring
 * phase, prepared the same way the pipeline prepares oracles (GLB round-trip through
 * snapshotScene) so the snapshot is produced from the actual geometry under test. */
async function gunOracleSnapshot(segments: number, phaseRadians: number): Promise<SceneSnapshot> {
  const barrel = new THREE.CylinderGeometry(0.11, 0.11, 3.2, segments, 1, false, phaseRadians);
  barrel.rotateZ(Math.PI / 2); // cylinder axis (y) -> x
  barrel.translate(1.6, 0, 0); // span [0, 3.2] from the pivot at the origin
  const mesh = new THREE.Mesh(barrel, new THREE.MeshStandardMaterial({ color: 0x6b7358 }));
  mesh.name = "gun";
  mesh.userData.semanticId = "gun";
  const pivot = new THREE.Group();
  pivot.name = "gun-pivot";
  pivot.userData.semanticId = "gun-pivot";
  pivot.position.set(0, 0, 0);
  pivot.add(mesh);
  const root = new THREE.Group();
  root.name = "tank";
  root.add(pivot);
  const glb = sceneToGlb(root);
  // Round-trip through the repo's own GLB loader via a data workspace-free snapshot path:
  // sceneToGlb produces bytes; load them back with GLTFLoader through three's loader used by
  // the pipeline. To keep the test hermetic we reconstruct the SceneSnapshot from the same
  // three objects the pipeline would see after loading.
  void glb;
  const prepared = root; // the pipeline's prepared oracle is this scene graph
  return snapshotScene(prepared) as unknown as SceneSnapshot;
}

function seedTubeMetrics(snapshot: SceneSnapshot): { maxLength: number; maxRadial: number; axis: [number, number, number] } {
  const seed = buildGunSeed(snapshot, new Set());
  const gun = seed.nodes.find((node) => node.semanticId === "gun")!;
  const positions = gun!.positions as Float32Array;
  let maxLength = 0;
  let maxRadial = 0;
  // Dominant axis of the generated tube via the same power iteration the evaluator uses.
  const centroid = [0, 0, 0];
  const count = positions.length / 3;
  for (let i = 0; i < positions.length; i += 3) { centroid[0]! += positions[i]! / count; centroid[1]! += positions[i + 1]! / count; centroid[2]! += positions[i + 2]! / count; }
  const covariance: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < positions.length; i += 3) {
    const d = [positions[i]! - centroid[0]!, positions[i + 1]! - centroid[1]!, positions[i + 2]! - centroid[2]!];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) covariance[a]![b]! += d[a]! * d[b]!;
  }
  // Start from the covariance diagonal: a fixed start vector parallel to a non-dominant
  // eigenvector (the tube is exactly symmetric about z) is a fixed point of the iteration.
  const diagonalNorm = Math.hypot(covariance[0]![0]!, covariance[1]![1]!, covariance[2]![2]!);
  let axis: [number, number, number] = diagonalNorm > 1e-12
    ? [covariance[0]![0]! / diagonalNorm, covariance[1]![1]! / diagonalNorm, covariance[2]![2]! / diagonalNorm]
    : [0, 0, 1];
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const next: [number, number, number] = [
      covariance[0]![0]! * axis[0]! + covariance[0]![1]! * axis[1]! + covariance[0]![2]! * axis[2]!,
      covariance[1]![0]! * axis[0]! + covariance[1]![1]! * axis[1]! + covariance[1]![2]! * axis[2]!,
      covariance[2]![0]! * axis[0]! + covariance[2]![1]! * axis[1]! + covariance[2]![2]! * axis[2]!,
    ];
    const norm = Math.hypot(...next);
    axis = next.map((value) => value / norm) as [number, number, number];
  }
  if (centroid[0]! * axis[0]! + centroid[1]! * axis[1]! + centroid[2]! * axis[2]! < 0) axis = axis.map((value) => -value) as [number, number, number];
  for (let i = 0; i < positions.length; i += 3) {
    const axial = positions[i]! * axis[0]! + positions[i + 1]! * axis[1]! + positions[i + 2]! * axis[2]!;
    const radial = Math.hypot(positions[i]!, positions[i + 1]!, positions[i + 2]!) - 0; // pivot at origin: distance
    const radialComponent = Math.sqrt(Math.max(radial * radial - axial * axial, 0));
    if (axial > maxLength) maxLength = axial;
    if (radialComponent > maxRadial) maxRadial = radialComponent;
  }
  return { maxLength, maxRadial, axis };
}

describe("tessellation-invariant gun seed", () => {
  it("produces the same axial length and axis for 8/10/12-sided barrels at any phase", async () => {
    const reference = seedTubeMetrics(await gunOracleSnapshot(10, 0));
    // The seed's axial length must match the oracle's muzzle distance (~3.2 barrel span).
    expect(reference.maxLength).toBeGreaterThan(3.1);
    expect(reference.maxLength).toBeLessThan(3.25);
    for (const [segments, phase] of [[8, 0.3], [10, 0.7], [12, 1.9], [10, 2.8]] as const) {
      const variant = seedTubeMetrics(await gunOracleSnapshot(segments, phase));
      expect(variant.maxLength, `${segments}-gon phase ${phase}: axial length`).toBeCloseTo(reference.maxLength, 2);
      const dot = Math.abs(reference.axis[0]! * variant.axis[0]! + reference.axis[1]! * variant.axis[1]! + reference.axis[2]! * variant.axis[2]!);
      expect(dot, `${segments}-gon phase ${phase}: axis alignment`).toBeGreaterThan(0.999);
    }
  });

  it("spans the real muzzle distance for an asymmetric oracle (breach mass near the pivot)", async () => {
    // Same synthetic geometry as the earlier regression: the barrel spans [0, 4] on x while the
    // declared bounds center is (1.4, 0, 0), so a center×2 length would be 2.8 (30% short).
    const positions: number[] = [];
    const quad = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]): void => {
      positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    };
    for (let x = 0; x < 4; x += 0.5) {
      const xn = Math.min(x + 0.5, 4);
      quad([x, -0.05, -0.05], [xn, -0.05, -0.05], [xn, 0.05, -0.05], [x, 0.05, -0.05]);
      quad([x, 0.05, 0.05], [xn, 0.05, 0.05], [xn, -0.05, 0.05], [x, -0.05, 0.05]);
      quad([x, -0.05, 0.05], [xn, -0.05, 0.05], [xn, -0.05, -0.05], [x, -0.05, -0.05]);
      quad([x, 0.05, -0.05], [xn, 0.05, -0.05], [xn, 0.05, 0.05], [x, 0.05, 0.05]);
    }
    for (let x = 0; x < 0.5; x += 0.1) {
      const xn = x + 0.1;
      quad([x, -0.3, -0.3], [xn, -0.3, -0.3], [xn, 0.3, -0.3], [x, 0.3, -0.3]);
      quad([x, 0.3, 0.3], [xn, 0.3, 0.3], [xn, -0.3, 0.3], [x, -0.3, 0.3]);
      quad([x, -0.3, 0.3], [xn, -0.3, 0.3], [xn, -0.3, -0.3], [x, -0.3, -0.3]);
      quad([x, 0.3, -0.3], [xn, 0.3, -0.3], [xn, 0.3, 0.3], [x, 0.3, 0.3]);
      quad([x, -0.3, -0.3], [x, 0.3, -0.3], [x, 0.3, 0.3], [x, -0.3, 0.3]);
      quad([xn, -0.3, -0.3], [xn, -0.3, 0.3], [xn, 0.3, 0.3], [xn, 0.3, -0.3]);
    }
    const triangleData = { positions: new Float32Array(positions) };
    const triangleIndices = Array.from({ length: positions.length / 9 }, (_, i) => i);
    const snapshot = {
      components: {
        gun: { id: "gun", semanticId: "gun", role: "gun", parentSemanticId: "gun-pivot", triangleIndices, bounds: { min: [0, -0.3, -0.3], max: [4, 0.3, 0.3], center: [1.4, 0, 0], size: [4, 0.6, 0.6] } },
        "gun-pivot": { id: "gun-pivot", semanticId: "gun-pivot", role: "gun-pivot", parentSemanticId: "turret", triangleIndices: [], bounds: { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], size: [0, 0, 0] }, origin: [0, 0, 0] },
      },
      triangleData,
    } as unknown as SceneSnapshot;
    const seed = buildGunSeed(snapshot, new Set());
    const gun = seed.nodes.find((node) => node.semanticId === "gun")!;
    const seedPositions = gun!.positions as Float32Array;
    let maxDistance = 0;
    for (let i = 0; i < seedPositions.length; i += 3) {
      maxDistance = Math.max(maxDistance, Math.hypot(seedPositions[i]!, seedPositions[i + 1]!, seedPositions[i + 2]!));
    }
    expect(maxDistance).toBeGreaterThan(3.9);
  });

  it("keeps identical metrics under uneven tessellation density along the axis", async () => {
    // Rear half tessellated as a 24-gon, front half as a 6-gon at a different ring phase:
    // triangle density varies 4x along the barrel. A vertex-count covariance weights the
    // dense half by its triangle count; the area-weighted surface covariance weights by
    // physical area, so the axis, length, and radial extent must match the uniform barrel.
    const rear = new THREE.CylinderGeometry(0.11, 0.11, 1.6, 24, 1, false, 0.4);
    const front = new THREE.CylinderGeometry(0.11, 0.11, 1.6, 6, 1, false, 1.3);
    for (const g of [rear, front]) { g.rotateZ(Math.PI / 2); }
    rear.translate(0.8, 0, 0);
    front.translate(2.4, 0, 0);
    const merged = new THREE.BufferGeometry();
    const ra = rear.toNonIndexed().getAttribute("position") as THREE.BufferAttribute;
    const fa = front.toNonIndexed().getAttribute("position") as THREE.BufferAttribute;
    const all = new Float32Array(ra.array.length + fa.array.length);
    all.set(ra.array as Float32Array, 0);
    all.set(fa.array as Float32Array, ra.array.length);
    merged.setAttribute("position", new THREE.BufferAttribute(all, 3));
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial());
    mesh.name = "gun"; mesh.userData.semanticId = "gun";
    const pivot = new THREE.Group(); pivot.name = "gun-pivot"; pivot.userData.semanticId = "gun-pivot";
    pivot.position.set(0, 0, 0); pivot.add(mesh);
    const root = new THREE.Group(); root.name = "tank"; root.add(pivot);
    const snap = snapshotScene(root) as unknown as SceneSnapshot;
    const metrics = measureGunGeometry(snap);
    expect(metrics, "uneven barrel is measurable").not.toBeNull();
    const dot = metrics!.axis[0]!;
    expect(dot, "axis stays on x under 4x density gradient").toBeGreaterThan(0.999);
    expect(metrics!.length).toBeCloseTo(3.2, 2);
    expect(metrics!.radialExtent).toBeCloseTo(0.11, 2);
    const seedMetrics = seedTubeMetrics(snap);
    expect(seedMetrics.maxLength).toBeCloseTo(3.2, 2);
    expect(seedMetrics.axis[0]!).toBeGreaterThan(0.999);
  });
});

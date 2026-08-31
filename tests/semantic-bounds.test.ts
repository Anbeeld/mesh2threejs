import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { evaluateLowPolyStyle, evaluateTankProfile, lowPolyFaithful, snapshotScene } from "../src/index.js";

/**
 * Bundle A1 regression (pipeline remediation plan §5.A1): semantic pivot bounds must be
 * INTRINSIC. A transform-only semantic anchor (group/pivot with zero owned triangles) must
 * measure as zero-volume bounds at its own origin — never as an aggregate of descendant
 * SEMANTIC geometry — while a semantic that owns triangles keeps exactly those intrinsic
 * bounds. `SceneComponent.bounds` has ONE meaning: geometry intrinsically owned by the
 * semantic.
 *
 * Historical failure mechanism (evidence E1/E2/E3): snapshotScene() fell back to
 * Box3.setFromObject() for geometryless semantic owners, giving SceneComponent.bounds a
 * second, incompatible "aggregate subtree" meaning. Style then compared those
 * non-equivalent bounds 1:1, so a correct derived candidate whose pivot owns an
 * articulated subtree failed style.envelope/style.center rows against an oracle whose
 * pivot anchor was a logical-only parent — despite identical pivot origins and identical
 * visible geometry.
 */

function semanticMesh(id: string, geometry: THREE.BufferGeometry, position: [number, number, number], rotation?: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x6b7358, roughness: 0.7, flatShading: true }));
  mesh.name = id;
  mesh.userData.semanticId = id;
  mesh.userData.critical = ["hull", "turret", "gun"].includes(id);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.position.set(...position);
  return mesh;
}

function pivotAnchor(id: string, position: [number, number, number]): THREE.Group {
  const group = new THREE.Group();
  group.name = id;
  group.userData.semanticId = id;
  group.position.set(...position);
  return group;
}

const GUN_PIVOT_ORIGIN: [number, number, number] = [0, 1.8, 0.55];
const TURRET_PIVOT_ORIGIN: [number, number, number] = [0, 1.8, -0.25];
const GUN_PIVOT_LOCAL = GUN_PIVOT_ORIGIN.map((value, axis) => value - TURRET_PIVOT_ORIGIN[axis]!) as [number, number, number];

function gunGeometry(): THREE.BufferGeometry {
  // Barrel along +Z, base at the pivot, 3.4 long: identical world geometry on both sides.
  // (toNonIndexed keeps oracle/candidate triangle topology identical; flatShading on the
  // material keeps the representation row deterministic for this stripped geometry.)
  const geometry = new THREE.CylinderGeometry(0.12, 0.12, 3.4, 10).toNonIndexed();
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, 1.7);
  return geometry;
}

/**
 * Asymmetric oracle: turret-pivot physically carries the turret mesh, but gun-pivot is a
 * transform anchor with NO owned triangles and NO physical gun descendant — the gun mesh
 * is a root-level sibling logically owned by gun-pivot through the prepared overlay.
 * Logical/articulation mapping stays valid (gun.parent resolves to gun-pivot) while the
 * pivot subtree shape differs from canonical derived composition.
 */
function asymmetricOracle(): THREE.Group {
  const root = new THREE.Group();
  root.name = "bounds-oracle";
  root.userData.forwardAxis = "+z";
  root.add(semanticMesh("hull", new THREE.BoxGeometry(3.2, 1.2, 6), [0, 0.4, 0]));

  const turretPivot = pivotAnchor("turret-pivot", TURRET_PIVOT_ORIGIN);
  turretPivot.add(semanticMesh("turret", new THREE.CylinderGeometry(1.15, 1.3, 0.9, 12), [0, 0, 0], [Math.PI / 2, 0, 0]));
  root.add(turretPivot);

  // Empty anchor under the turret assembly (canonical position) but with no children.
  turretPivot.add(pivotAnchor("gun-pivot", GUN_PIVOT_LOCAL));

  // Gun mesh: physical sibling at root, LOGICAL child of gun-pivot.
  const gun = semanticMesh("gun", gunGeometry(), [0, 1.8, 0.55]);
  gun.userData.logicalOwner = "gun-pivot";
  root.add(gun);
  return root;
}

/**
 * Canonical derived composition: gun-pivot physically nests under turret-pivot and owns the
 * gun mesh, exactly what derivation.ts hard-codes for tank candidates (evidence E3 — the
 * hierarchy is articulation doctrine and must not be flattened to satisfy the evaluator).
 */
function derivedCandidate(): THREE.Group {
  const root = new THREE.Group();
  root.name = "bounds-candidate";
  root.userData.forwardAxis = "+z";
  root.add(semanticMesh("hull", new THREE.BoxGeometry(3.2, 1.2, 6), [0, 0.4, 0]));

  const turretPivot = pivotAnchor("turret-pivot", TURRET_PIVOT_ORIGIN);
  turretPivot.add(semanticMesh("turret", new THREE.CylinderGeometry(1.15, 1.3, 0.9, 12), [0, 0, 0], [Math.PI / 2, 0, 0]));

  const gunPivot = pivotAnchor("gun-pivot", GUN_PIVOT_LOCAL);
  gunPivot.add(semanticMesh("gun", gunGeometry(), [0, 0, 0]));
  turretPivot.add(gunPivot);
  root.add(turretPivot);
  return root;
}

const expectZeroVolumeAt = (bounds: { min: number[]; max: number[]; size: number[]; center: number[] }, point: number[]): void => {
  point.forEach((value, axis) => {
    expect(bounds.min[axis]).toBeCloseTo(value, 6);
    expect(bounds.max[axis]).toBeCloseTo(value, 6);
    expect(bounds.size[axis]).toBeCloseTo(0, 6);
    expect(bounds.center[axis]).toBeCloseTo(value, 6);
  });
};

describe("intrinsic semantic bounds (remediation bundle B)", () => {
  test("geometryless pivot bounds are zero-volume at the pivot origin and invariant under semantic descendants", () => {
    const candidate = derivedCandidate();
    const snapshot = snapshotScene(candidate);
    const pivot = snapshot.components["gun-pivot"]!;
    expect(pivot.triangleIndices.length).toBe(0);
    expect(pivot.origin).toBeDefined();
    expectZeroVolumeAt(pivot.bounds, pivot.origin!);

    // Adding a large SEMANTIC descendant under the pivot must not inflate intrinsic bounds:
    // the descendant carries its own triangles and its own component identity.
    const huge = semanticMesh("gun-marker", new THREE.BoxGeometry(20, 20, 20), [30, 30, 30]);
    candidate.getObjectByName("gun-pivot")!.add(huge);
    const inflated = snapshotScene(candidate);
    expect(inflated.components["gun-marker"]!.triangleIndices.length).toBeGreaterThan(0);
    expectZeroVolumeAt(inflated.components["gun-pivot"]!.bounds, inflated.components["gun-pivot"]!.origin!);

    // Removing the descendant restores the identical intrinsic view.
    candidate.getObjectByName("gun-pivot")!.remove(huge);
    const restored = snapshotScene(candidate);
    expect(restored.components["gun-pivot"]!.triangleIndices.length).toBe(0);
    expectZeroVolumeAt(restored.components["gun-pivot"]!.bounds, restored.components["gun-pivot"]!.origin!);
  });

  test("unnamed descendant geometry is attributed to the pivot semantic with exactly its own bounds", () => {
    // The single meaning still attributes geometry intrinsically: a mesh child WITHOUT its
    // own semanticId is owned by the ancestor pivot, and the pivot bounds are then the
    // bounds of exactly that geometry (not of further-out semantic descendants).
    const root = derivedCandidate();
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.4).toNonIndexed(), new THREE.MeshStandardMaterial({ color: 0x6b7358 }));
    root.getObjectByName("gun-pivot")!.add(collar);
    const snapshot = snapshotScene(root);
    const pivot = snapshot.components["gun-pivot"]!;
    expect(pivot.triangleIndices.length).toBeGreaterThan(0);
    expect(pivot.bounds.size[0]).toBeCloseTo(0.5, 6);
    expect(pivot.bounds.size[2]).toBeCloseTo(0.4, 6);
    expect(pivot.bounds.center[2]).toBeCloseTo(GUN_PIVOT_ORIGIN[2], 6);
    // The semantic gun descendant's triangles stay out of the pivot's intrinsic set.
    expect(snapshot.components.gun!.triangleIndices.length).toBeGreaterThan(0);
    expect(snapshot.components.gun!.bounds.size[2]).toBeCloseTo(3.4, 6);
  });

  test("a semantic with intrinsic triangles still reports exactly those intrinsic bounds", () => {
    const snapshot = snapshotScene(derivedCandidate());
    const gun = snapshot.components.gun!;
    expect(gun.triangleIndices.length).toBeGreaterThan(0);
    // Hierarchy-independence of intrinsic mesh bounds: the same gun world geometry measured
    // through a different ancestor context (oracle sibling vs candidate pivot child) must
    // produce byte-identical intrinsic bounds.
    const oracleGun = snapshotScene(asymmetricOracle()).components.gun!;
    expect(gun.bounds.min).toEqual(oracleGun.bounds.min);
    expect(gun.bounds.max).toEqual(oracleGun.bounds.max);
    expect(gun.bounds.size).toEqual(oracleGun.bounds.size);
    expect(gun.bounds.center).toEqual(oracleGun.bounds.center);
    // Hull likewise: mesh component bounds are ordinary intrinsic geometry bounds.
    expect(snapshot.components.hull!.bounds.size[2]).toBeCloseTo(6, 6);
  });

  test("style pivot envelope/center rows pass when origins agree, without name exemptions", () => {
    const oracle = snapshotScene(asymmetricOracle());
    const candidate = snapshotScene(derivedCandidate());

    // Preconditions of the scenario: origins and visible geometry agree.
    expect(candidate.components["gun-pivot"]!.origin).toBeDefined();
    for (const axis of [0, 1, 2]) {
      expect(candidate.components["gun-pivot"]!.origin![axis]).toBeCloseTo(oracle.components["gun-pivot"]!.origin![axis]!, 6);
      expect(candidate.components.gun!.bounds.size[axis]).toBeCloseTo(oracle.components.gun!.bounds.size[axis]!, 6);
    }
    // Logical/articulation mapping remains valid on both sides.
    expect(oracle.components.gun!.parentSemanticId).toBe("gun-pivot");
    expect(candidate.components.gun!.parentSemanticId).toBe("gun-pivot");

    const report = evaluateLowPolyStyle(oracle, candidate, lowPolyFaithful);
    const failing = report.rows.filter((row) => !row.passed).map((row) => row.code);
    expect(failing, `pivot rows must pass with intrinsic bounds; failing: ${failing.join(", ")}`).toEqual([]);
    expect(report.passed).toBe(true);
  });

  test("gun phase rows pass on the asymmetric hierarchy (articulation not weakened by the fix)", () => {
    const oracle = snapshotScene(asymmetricOracle());
    const candidate = snapshotScene(derivedCandidate());
    const report = evaluateTankProfile(oracle, candidate, { certification: "oracle-relative", phases: new Set(["gun"]) });
    for (const code of ["gun.geometry", "gun.pose"]) {
      const row = report.rows.find((item) => item.code === code);
      expect(row?.passed, `${code}: ${row?.message}`).toBe(true);
    }
  });

  test("negative: missing intrinsic pivot geometry still fails style (fix is not an automatic pass)", () => {
    // Oracle gun-pivot OWNS real collar triangles (unnamed child mesh under the pivot).
    const oracleRoot = asymmetricOracle();
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.4).toNonIndexed(), new THREE.MeshStandardMaterial({ color: 0x6b7358 }));
    oracleRoot.getObjectByName("gun-pivot")!.add(collar);
    const oracle = snapshotScene(oracleRoot);
    expect(oracle.components["gun-pivot"]!.triangleIndices.length).toBeGreaterThan(0);

    // Candidate: same origins, same gun geometry, but a GEOMETRYLESS gun-pivot — the collar
    // is missing. Intrinsic oracle collar bounds vs zero-volume candidate bounds must fail
    // the envelope rows; the pivot fix must not turn missing geometry into a pass.
    const candidate = snapshotScene(derivedCandidate());
    const report = evaluateLowPolyStyle(oracle, candidate, lowPolyFaithful);
    expect(report.rows.find((row) => row.code === "style.envelope.gun-pivot.0")?.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  test("negative (mirrored): candidate-owned collar vs geometryless oracle pivot also fails", () => {
    const oracle = snapshotScene(asymmetricOracle());
    const candidateRoot = derivedCandidate();
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.4).toNonIndexed(), new THREE.MeshStandardMaterial({ color: 0x6b7358 }));
    candidateRoot.getObjectByName("gun-pivot")!.add(collar);
    const candidate = snapshotScene(candidateRoot);
    const report = evaluateLowPolyStyle(oracle, candidate, lowPolyFaithful);
    expect(report.rows.find((row) => row.code === "style.envelope.gun-pivot.0")?.passed).toBe(false);
  });

  test("asymmetric fixture: oracle and candidate pivot bounds are identical under the single meaning", () => {
    // Regression pin for the pre-fix mechanism: under the OLD dual meaning the oracle
    // gun-pivot (empty anchor) measured as a degenerate all-zero box at [0,0,0] while the
    // candidate pivot measured as its subtree AABB, so identical origins produced
    // style.center/style.envelope false positives. With intrinsic bounds both sides
    // measure zero-volume at the shared origin and compare equal.
    const oracle = snapshotScene(asymmetricOracle());
    const candidate = snapshotScene(derivedCandidate());
    const oraclePivot = oracle.components["gun-pivot"]!;
    const candidatePivot = candidate.components["gun-pivot"]!;
    expect(oraclePivot.bounds.center).toEqual(candidatePivot.bounds.center);
    expect(oraclePivot.bounds.size).toEqual(candidatePivot.bounds.size);
  });
});

describe("style rows stay honest for ordinary mesh components", () => {
  test("mesh envelope deviations still fail after the pivot fix", () => {
    const oracle = snapshotScene(asymmetricOracle());
    const bigger = derivedCandidate();
    bigger.getObjectByName("hull")!.scale.set(1.5, 1, 1);
    const candidate = snapshotScene(bigger);
    const report = evaluateLowPolyStyle(oracle, candidate, lowPolyFaithful);
    expect(report.rows.find((row) => row.code === "style.envelope.hull.0")?.passed).toBe(false);
    expect(report.passed).toBe(false);
  });
});

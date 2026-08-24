import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { validateAssemblyExclusions, type AssemblyExclusion, type SourceNodeIdentity } from "../src/core/oracle.js";
import { oracleGeometryDisposition, isNonSubject } from "../src/core/assembly.js";
import { snapshotScene } from "../src/core/geometry.js";

/** Tank-like source node tree for testing: 7 nodes with parent-child relationships. */
const SOURCE_NODES: SourceNodeIdentity[] = [
  { id: "node:0", parentId: null },        // root
  { id: "node:1", parentId: "node:0" },    // hull
  { id: "node:2", parentId: "node:0" },    // turret-pivot
  { id: "node:3", parentId: "node:2" },    // turret (under turret-pivot)
  { id: "node:4", parentId: "node:2" },    // gun-pivot (under turret-pivot)
  { id: "node:5", parentId: "node:4" },    // gun (under gun-pivot)
  { id: "node:20", parentId: "node:0" },   // display stand (unmapped)
];

const SEMANTIC_MAP = {
  "node:1": "hull",
  "node:2": "turret-pivot",
  "node:3": "turret",
  "node:4": "gun-pivot",
  "node:5": "gun",
  // node:20 deliberately unmapped
};

describe("strict assembly exclusion authority", () => {
  test("valid exclusion for an unmapped non-subject node passes", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:20", kind: "non-subject", reason: "display stand" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, SOURCE_NODES, SEMANTIC_MAP)).not.toThrow();
  });

  test("semantic alias rejected — nodeId must be exact node:N", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "display-stand", kind: "non-subject", reason: "fixture" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, SOURCE_NODES, SEMANTIC_MAP)).toThrow(/exact source node:N identity/);
  });

  test("unknown node rejected", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:999", kind: "non-subject", reason: "unknown" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, SOURCE_NODES, SEMANTIC_MAP)).toThrow(/does not exist in the source GLB/);
  });

  test("duplicate node rejected", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:20", kind: "non-subject", reason: "first" },
      { nodeId: "node:20", kind: "microdetail", reason: "second" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, SOURCE_NODES, SEMANTIC_MAP)).toThrow(/duplicate nodeId/);
  });

  test("invalid runtime kind rejected", () => {
    const exclusions = [
      { nodeId: "node:20", kind: "whatever", reason: "bad kind" },
    ] as unknown as AssemblyExclusion[];
    expect(() => validateAssemblyExclusions(exclusions, SOURCE_NODES, SEMANTIC_MAP)).toThrow(/kind must be/);
  });

  test("empty reason rejected", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:20", kind: "non-subject", reason: "" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, SOURCE_NODES, SEMANTIC_MAP)).toThrow(/requires a reason/);
  });

  test("protected semantic on the node itself rejected", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:1", kind: "non-subject", reason: "try to exclude hull" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, SOURCE_NODES, SEMANTIC_MAP)).toThrow(/cannot exclude a subtree containing required semantic "hull"/);
  });

  test("protected descendant in subtree rejected (parent exclusion)", () => {
    // Exclude node:2 (turret-pivot) which has turret (node:3) and gun-pivot (node:4) as descendants.
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:2", kind: "non-subject", reason: "try to exclude turret-pivot subtree" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, SOURCE_NODES, SEMANTIC_MAP)).toThrow(/cannot exclude a subtree containing required semantic/);
  });

  test("protected descendant deep in subtree rejected", () => {
    // Exclude node:0 (root) which contains everything.
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:0", kind: "non-subject", reason: "try to exclude root" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, SOURCE_NODES, SEMANTIC_MAP)).toThrow(/cannot exclude a subtree containing required semantic/);
  });

  test("canonical ordering: exclusions sorted by nodeId", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:20", kind: "non-subject", reason: "stand" },
    ];
    const result = validateAssemblyExclusions(exclusions, SOURCE_NODES, SEMANTIC_MAP);
    expect(result).toHaveLength(1);
    expect(result[0]!.nodeId).toBe("node:20");
  });

  test("multiple valid exclusions sorted by nodeId", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:20", kind: "non-subject", reason: "stand" },
      { nodeId: "node:6", kind: "presentation-fixture", reason: "floor" },
    ];
    // node:6 doesn't exist in SOURCE_NODES, add it
    const nodes = [...SOURCE_NODES, { id: "node:6", parentId: "node:0" }];
    const result = validateAssemblyExclusions(exclusions, nodes, SEMANTIC_MAP);
    expect(result[0]!.nodeId).toBe("node:6");
    expect(result[1]!.nodeId).toBe("node:20");
  });

  test("presentation-fixture and microdetail kinds allowed", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:20", kind: "presentation-fixture", reason: "presentation floor" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, SOURCE_NODES, SEMANTIC_MAP)).not.toThrow();
  });
});

describe("subject-geometry disposition", () => {
  function makeMesh(name: string, size = 4): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial());
    mesh.name = name;
    mesh.userData.semanticId = name;
    return mesh;
  }

  test("non-subject exclusion sets disposition to non-subject", () => {
    const mesh = makeMesh("display-stand", 10);
    mesh.userData.insignificant = true;
    mesh.userData.exclusionKind = "non-subject";
    expect(oracleGeometryDisposition(mesh)).toBe("non-subject");
    expect(isNonSubject(mesh)).toBe(true);
  });

  test("presentation-fixture exclusion sets disposition to non-subject", () => {
    const mesh = makeMesh("floor", 10);
    mesh.userData.insignificant = true;
    mesh.userData.exclusionKind = "presentation-fixture";
    expect(oracleGeometryDisposition(mesh)).toBe("non-subject");
  });

  test("microdetail exclusion sets disposition to subject-microdetail", () => {
    const mesh = makeMesh("bolt", 0.1);
    mesh.userData.insignificant = true;
    mesh.userData.exclusionKind = "microdetail";
    expect(oracleGeometryDisposition(mesh)).toBe("subject-microdetail");
    expect(isNonSubject(mesh)).toBe(false);
  });

  test("unexcluded mesh has subject disposition", () => {
    const mesh = makeMesh("hull", 6);
    expect(oracleGeometryDisposition(mesh)).toBe("subject");
    expect(isNonSubject(mesh)).toBe(false);
  });

  test("non-subject mesh is filtered from fidelity snapshot (§4.7)", () => {
    const root = new THREE.Group();
    const hull = makeMesh("hull", 6);
    hull.userData.semanticId = "hull";
    const stand = makeMesh("display-stand", 20);
    stand.userData.semanticId = "display-stand";
    stand.userData.insignificant = true;
    stand.userData.exclusionKind = "non-subject";
    root.add(hull, stand);
    root.updateMatrixWorld(true);
    const snapshot = snapshotScene(root);
    // The snapshot should contain hull geometry but NOT display-stand geometry.
    const componentIds = Object.keys(snapshot.components);
    expect(componentIds).toContain("hull");
    expect(componentIds).not.toContain("display-stand");
  });

  test("microdetail mesh is RETAINED in fidelity snapshot (§4.9)", () => {
    const root = new THREE.Group();
    const hull = makeMesh("hull", 6);
    hull.userData.semanticId = "hull";
    const bolt = makeMesh("bolt", 0.1);
    bolt.userData.semanticId = "bolt";
    bolt.userData.insignificant = true;
    bolt.userData.exclusionKind = "microdetail";
    root.add(hull, bolt);
    root.updateMatrixWorld(true);
    const snapshot = snapshotScene(root);
    const componentIds = Object.keys(snapshot.components);
    // microdetail is still subject geometry — retained in snapshot.
    expect(componentIds).toContain("hull");
    expect(componentIds).toContain("bolt");
  });

  test("non-subject parent excludes descendant meshes from snapshot via ancestor walk", () => {
    const root = new THREE.Group();
    const standGroup = new THREE.Group();
    standGroup.name = "display-stand-group";
    standGroup.userData.insignificant = true;
    standGroup.userData.exclusionKind = "non-subject";
    const standMesh = makeMesh("stand-mesh", 20);
    standMesh.userData.semanticId = "stand-mesh";
    standGroup.add(standMesh);
    const hull = makeMesh("hull", 6);
    hull.userData.semanticId = "hull";
    root.add(hull, standGroup);
    root.updateMatrixWorld(true);
    const snapshot = snapshotScene(root);
    const componentIds = Object.keys(snapshot.components);
    expect(componentIds).toContain("hull");
    expect(componentIds).not.toContain("stand-mesh");
  });
});
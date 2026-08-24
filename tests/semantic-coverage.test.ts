import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { assertAssemblyCoverage, evaluateAssemblyCoverage } from "../src/core/assembly.js";

/**
 * Source assembly coverage attacks (plan Ãƒâ€šÃ‚Â§22 semantic coverage 43ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“46 and Ãƒâ€šÃ‚Â§11.5 multipart
 * fixture requirements).
 */

function mesh(geometry: THREE.BufferGeometry, name: string, semanticId?: string): THREE.Mesh {
  const object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  object.name = name;
  if (semanticId) object.userData.semanticId = semanticId;
  return object;
}

function bigGeometry(size = 4): THREE.BufferGeometry {
  return new THREE.BoxGeometry(size, size, size);
}

/**
 * Ãƒâ€šÃ‚Â§11.5 fixture shape: multipart turret assembly + cupola + gun subtree + tiny detail.
 * The turret-pivot carries the phase semantic, so ownership CLOSURE covers every
 * disconnected significant child beneath it.
 */
function multipartTank(): THREE.Group {
  const root = new THREE.Group();
  const hull = mesh(bigGeometry(6), "shell", "hull");
  const turretPivot = new THREE.Group();
  turretPivot.name = "turret-pivot";
  turretPivot.userData.semanticId = "turret-pivot";
  turretPivot.add(mesh(bigGeometry(), "turret-shell", "turret"));
  turretPivot.add(mesh(bigGeometry(2), "cheek", "turret-cheeks"));
  turretPivot.add(mesh(new THREE.BoxGeometry(1, 1, 1), "cupola", "cupola"));
  const gunPivot = new THREE.Group();
  gunPivot.name = "gun-pivot";
  gunPivot.userData.semanticId = "gun-pivot";
  gunPivot.add(mesh(new THREE.BoxGeometry(0.5, 0.5, 5), "gun", "gun"));
  turretPivot.add(gunPivot);
  root.add(hull, turretPivot);
  return root;
}

/** The demonstrated failure: only ONE turret child is conveniently mapped; the pivot carries NO semantic. */
function oneChildMappedTank(): THREE.Group {
  const root = new THREE.Group();
  root.add(mesh(bigGeometry(6), "shell", "hull"));
  const unmappedAssembly = new THREE.Group();
  unmappedAssembly.name = "turret-group-no-semantics";
  unmappedAssembly.add(mesh(bigGeometry(), "turret-shell", "turret"));
  unmappedAssembly.add(mesh(bigGeometry(2), "cheek"));
  // Small irrelevant detail inside the same unmapped assembly.
  unmappedAssembly.add(mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), "bolt"));
  root.add(unmappedAssembly);
  return root;
}

describe("source assembly coverage (Ãƒâ€šÃ‚Â§11)", () => {
  test("a fully owned multipart assembly passes coverage (fixture control)", () => {
    const report = evaluateAssemblyCoverage(multipartTank(), "tank");
    expect(report.unresolved).toEqual([]);
    expect(report.passed).toBe(true);
    const turretRow = report.phases.find((phase) => phase.phase === "turret")!;
    expect(turretRow.ownedMeshes).toContain("turret-shell");
    expect(turretRow.ownedMeshes).toContain("cheek");
    expect(report.unresolved.some((entry) => entry.meshName === "cupola")).toBe(false);
  });

  test("mapping only one child of a multipart assembly blocks coverage (attacks 43/44)", () => {
    const failingRoot = oneChildMappedTank();
    const report = evaluateAssemblyCoverage(failingRoot, "tank");
    expect(report.passed).toBe(false);
    expect(report.unresolved.map((entry) => entry.meshName)).toEqual(["cheek"]);
    expect(() => assertAssemblyCoverage(failingRoot, "tank")).toThrow(/semantic assembly coverage failed/);
    expect(() => assertAssemblyCoverage(failingRoot, "tank")).toThrow(/cheek/);
  });

  test("a gun child mislabeled outside gun ownership is unresolved, not silently dropped (attack 45)", () => {
    const root = multipartTank();
    const gun = root.getObjectByName("gun")!;
    delete gun.userData.semanticId;
    gun.userData.semanticId = "mystery-cannon";
    const report = evaluateAssemblyCoverage(root, "tank");
    expect(report.passed).toBe(false);
    expect(report.unresolved.some((entry) => entry.meshName === "gun")).toBe(true);
  });

  test("small irrelevant children without any semantic ancestry are allowed as insignificant (attack 46)", () => {
    const report = evaluateAssemblyCoverage(oneChildMappedTank(), "tank");
    expect(report.excludedInsignificant.map((entry) => entry.objectId)).toContain("bolt");
    expect(report.unresolved.some((entry) => entry.meshName === "bolt")).toBe(false);
    // And a fully-owned bolt-class detail stays owned rather than flagged.
    expect(evaluateAssemblyCoverage(multipartTank(), "tank").passed).toBe(true);
  });

  test("assembly-relative significance protects small silhouette-defining children (remaining closure Ãƒâ€šÃ‚Â§9)", () => {
    // Hull mapped; an unmapped-marker assembly carries a large block, a small-but-visible
    // mantlet (globally insignificant, but >=2% of its assembly), and a tiny bolt.
    const root = new THREE.Group();
    root.add(mesh(new THREE.BoxGeometry(10, 10, 10), "shell", "hull"));
    const assembly = new THREE.Group();
    assembly.name = "unmapped-block";
    assembly.userData.semanticId = "unmapped-module";
    assembly.add(mesh(new THREE.BoxGeometry(4, 4, 4), "block"));
    const mantlet = mesh(new THREE.BoxGeometry(0.645, 0.645, 0.645), "mantlet");
    assembly.add(mantlet);
    assembly.add(mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), "bolt"));
    root.add(assembly);

    const report = evaluateAssemblyCoverage(root, "tank");
    // The mantlet is globally insignificant (<0.5% of total area) but silhouette-significant
    // within its nearest critical assembly: it must NOT silently disappear.
    expect(report.unresolved.map((entry) => entry.meshName)).toContain("mantlet");
    // The tiny bolt remains deterministically excludable.
    expect(report.entries.find((entry) => entry.meshName === "bolt")!.classification.kind).toBe("insignificant-excluded");

    // Explicit exclusion carries provenance: marking the mantlet insignificant resolves it.
    mantlet.userData.insignificant = true;
    const explicit = evaluateAssemblyCoverage(root, "tank");
    expect(explicit.unresolved.map((entry) => entry.meshName)).not.toContain("mantlet");
    expect(explicit.entries.find((entry) => entry.meshName === "mantlet")!.classification.kind).toBe("explicitly-excluded");
  });
});
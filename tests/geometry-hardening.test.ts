import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { evaluateTankProfile } from "../src/profiles/tank.js";
import { auditCandidateSource } from "../src/core/candidate.js";
import { countConnectedIslands } from "../src/core/measurement.js";
import { snapshotScene } from "../src/core/geometry.js";
import { semanticMesh } from "./helpers/scenes.js";
import { createSlopedTank, subdividedBoxGeometry } from "./helpers/tank-fixtures.js";

function slopedPair(candidateOptions: Parameters<typeof createSlopedTank>[0] = {}) {
  return {
    oracle: snapshotScene(createSlopedTank()),
    candidate: snapshotScene(createSlopedTank(candidateOptions)),
  };
}

describe("section fidelity is topology independent", () => {
  test("identical sloped geometry with denser tessellation passes sections, planes, and radiality", () => {
    const { oracle, candidate } = slopedPair({ detailMultiplier: 8, wheelSegments: 24 });
    const report = evaluateTankProfile(oracle, candidate, { certification: "oracle-relative" });
    expect(report.rows.find((row) => row.code === "hull.sections")?.passed).toBe(true);
    expect(report.rows.find((row) => row.code === "hull.planes")?.passed).toBe(true);
    expect(report.rows.find((row) => row.code === "running-gear.radiality")?.passed).toBe(true);
  });

  test("a rectangular slab stack with station-fitting AABBs fails sections and contiguity", () => {
    const oracle = snapshotScene(createSlopedTank());
    const candidateRoot = new THREE.Group();
    candidateRoot.name = "slab-stack";
    candidateRoot.userData.forwardAxis = "+z";
    for (let index = 0; index < 14; index += 1) {
      candidateRoot.add(semanticMesh(`hull-${index}`, new THREE.BoxGeometry(3.1, 1.1, 0.38), [0, 1.05, -2.9 + index * 0.48]));
    }
    const report = evaluateTankProfile(oracle, snapshotScene(candidateRoot), { certification: "oracle-relative" });
    expect(report.rows.find((row) => row.code === "hull.sections")?.passed).toBe(false);
    expect(report.rows.find((row) => row.code === "hull.contiguity")?.passed).toBe(false);
  });
});

describe("principal-plane fidelity", () => {
  test("same geometry with different tessellation yields matching planes", () => {
    const { oracle, candidate } = slopedPair({ detailMultiplier: 8 });
    const report = evaluateTankProfile(oracle, candidate, { certification: "oracle-relative" });
    const row = report.rows.find((item) => item.code === "hull.planes");
    expect(row?.passed).toBe(true);
  });

  test("correct normals in wrong locations fail even with a matching normal histogram", () => {
    const oracle = snapshotScene(createSlopedTank());
    // Mirror the hull in Z: every plane normal reappears somewhere, but front/rear sloped
    // surfaces sit at swapped offsets and locations.
    const candidateRoot = createSlopedTank();
    const hull = candidateRoot.getObjectByName("hull") as THREE.Mesh;
    hull.scale.z = -1;
    hull.position.z = 0.65;
    const report = evaluateTankProfile(oracle, snapshotScene(candidateRoot), { certification: "oracle-relative" });
    expect(report.rows.find((item) => item.code === "hull.planes")?.passed).toBe(false);
  });

  test("front/rear Y/Z slopes alone are detected without involving the X axis", () => {
    const oracle = snapshotScene(createSlopedTank());
    // Replace the sloped hull with an AABB-matched rectangular prism built from custom triangles.
    const candidateRoot = new THREE.Group();
    candidateRoot.name = "box-hull";
    candidateRoot.userData.forwardAxis = "+z";
    candidateRoot.add(semanticMesh("hull", subdividedBoxGeometry(3.1, 1.1, 5.95), [0, 1.05, 0.325]));
    const report = evaluateTankProfile(oracle, snapshotScene(candidateRoot), { certification: "oracle-relative" });
    const row = report.rows.find((item) => item.code === "hull.planes");
    expect(row?.passed).toBe(false);
    expect(row?.message).toMatch(/missing major planes/i);
  });
});

describe("hull contiguity contact graph", () => {
  function plateChain(count: number, spacing: number, gapAfter?: number): THREE.Group {
    const root = new THREE.Group();
    root.name = "plate-chain";
    root.userData.forwardAxis = "+z";
    let offset = 0;
    for (let index = 0; index < count; index += 1) {
      root.add(semanticMesh(`hull-${index}`, new THREE.BoxGeometry(3.0, 1.0, 0.55), [0, 1.0, offset]));
      offset += spacing;
      if (index === gapAfter) offset += 2.0;
    }
    return root;
  }

  test("ten plates touching only their neighbors form a connected graph and pass", () => {
    const candidate = snapshotScene(plateChain(10, 0.55));
    const report = evaluateTankProfile(snapshotScene(createSlopedTank()), candidate, { certification: "oracle-relative" });
    expect(report.rows.find((row) => row.code === "hull.contiguity")?.passed).toBe(true);
  });

  test("two disconnected hull clusters fail against the contiguous oracle", () => {
    const candidate = snapshotScene(plateChain(10, 0.55, 4));
    const report = evaluateTankProfile(snapshotScene(createSlopedTank()), candidate, { certification: "oracle-relative" });
    expect(report.rows.find((row) => row.code === "hull.contiguity")?.passed).toBe(false);
    expect(report.rows.find((row) => row.code === "hull.contiguity")?.message).toMatch(/unexplained pieces|no significant oracle counterpart/iu);
  });

  test("one semantic id containing two islands fails internally", () => {
    const first = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    const second = new THREE.BoxGeometry(1, 1, 1).translate(6, 0, 0).toNonIndexed();
    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.Float32BufferAttribute(
      [...Array.from(first.getAttribute("position").array as Float32Array), ...Array.from(second.getAttribute("position").array as Float32Array)], 3));
    const root = new THREE.Group();
    root.name = "split-hull";
    root.add(semanticMesh("hull", merged, [0, 1, 0]));
    const snapshot = snapshotScene(root);
    expect(countConnectedIslands(snapshot, "hull")).toBe(2);
    const report = evaluateTankProfile(snapshotScene(createSlopedTank()), snapshot, { certification: "oracle-relative" });
    expect(report.rows.find((row) => row.code === "hull.contiguity")?.passed).toBe(false);
  });
});

describe("turret section truth", () => {
  test("subdivided rectangular turret with matched AABB fails regardless of triangle count", () => {
    const oracle = snapshotScene(createSlopedTank());
    const candidateRoot = createSlopedTank();
    const turret = candidateRoot.getObjectByName("turret") as THREE.Mesh;
    turret.geometry.dispose();
    turret.geometry = subdividedBoxGeometry(2.05, 0.82, 2.15, 6);
    const report = evaluateTankProfile(oracle, snapshotScene(candidateRoot), { certification: "oracle-relative" });
    const row = report.rows.find((item) => item.code === "turret.sections");
    expect(row?.passed).toBe(false);
  });

  test("faceted low-poly turret with matching contour passes", () => {
    const { oracle, candidate } = slopedPair({ detailMultiplier: 4 });
    const report = evaluateTankProfile(oracle, candidate, { certification: "oracle-relative" });
    expect(report.rows.find((row) => row.code === "turret.sections")?.passed).toBe(true);
  });
});

describe("running gear radial truth", () => {
  test("subdivided cuboid wheels fail decisively without primitive signatures", () => {
    const oracle = snapshotScene(createSlopedTank());
    const candidateRoot = createSlopedTank();
    for (const side of [-1, 1]) {
      for (let index = 0; index < 5; index += 1) {
        const wheel = candidateRoot.getObjectByName(`road-wheel-${side}-${index}`) as THREE.Mesh;
        wheel.geometry.dispose();
        wheel.geometry = subdividedBoxGeometry(0.98, 0.98, 0.24, 4);
      }
    }
    const report = evaluateTankProfile(oracle, snapshotScene(candidateRoot), { certification: "oracle-relative" });
    const row = report.rows.find((item) => item.code === "running-gear.radiality");
    expect(row?.passed).toBe(false);
    expect(row?.message).toMatch(/non-radial|coverage/i);
  });

  test("coarse faceted wheels pass", () => {
    const { oracle, candidate } = slopedPair({ wheelSegments: 8 });
    const report = evaluateTankProfile(oracle, candidate, { certification: "oracle-relative" });
    expect(report.rows.find((row) => row.code === "running-gear.radiality")?.passed).toBe(true);
    expect(report.rows.find((row) => row.code === "running-gear.axles")?.passed).toBe(true);
  });
});

describe("orientation proof is never deferred", () => {
  test("a hull-only candidate must physically match fore/aft asymmetry, not receive a free pass", async () => {
    const oracle = snapshotScene(createSlopedTank());
    const hullOnlyRoot = new THREE.Group();
    hullOnlyRoot.name = "hull-only";
    hullOnlyRoot.userData.forwardAxis = "+z";
    const hullMesh = createSlopedTank().getObjectByName("hull") as THREE.Mesh;
    hullOnlyRoot.add(semanticMesh("hull", hullMesh.geometry.clone(), [0, 0, 0]));
    const passing = evaluateTankProfile(oracle, snapshotScene(hullOnlyRoot), { certification: "oracle-relative" });
    const orientationPassing = passing.rows.find((row) => row.code === "orientation.physical");
    expect(orientationPassing?.passed).toBe(true);
    expect(orientationPassing?.message).toMatch(/hull-local fore\/aft section signature/);

    // Mirror the hull fore/aft: the hull-local section signature reverses and must fail.
    const mirroredRoot = new THREE.Group();
    mirroredRoot.name = "mirrored-hull-only";
    mirroredRoot.userData.forwardAxis = "+z";
    const mirroredHull = semanticMesh("hull", hullMesh.geometry.clone(), [0, 0, 0]);
    mirroredHull.scale.z = -1;
    mirroredRoot.add(mirroredHull);
    const failing = evaluateTankProfile(oracle, snapshotScene(mirroredRoot), { certification: "oracle-relative" });
    const orientationFailing = failing.rows.find((row) => row.code === "orientation.physical");
    expect(orientationFailing?.passed).toBe(false);
    expect(orientationFailing?.message).toMatch(/reversed/);
  });
});

describe("candidate audit structural magnitude only", () => {
  test("typed control cages of several hundred values are legal", () => {
    const cage = `const cage = new Float32Array([${Array.from({ length: 420 }, (_, index) => (index % 7) - 3).join(",")}]);\n`;
    expect(auditCandidateSource(cage).passed).toBe(true);
  });

  test("large topology dumps remain illegal", () => {
    const dump = `const data = new Float32Array([${Array.from({ length: 60_000 }, (_, index) => index % 2).join(",")}]);`;
    expect(auditCandidateSource(dump).findings.some((finding) => finding.code !== "dynamic-local-import")).toBe(true);
    const base64 = `const embedded = atob("${"A".repeat(400)}");`;
    expect(auditCandidateSource(base64).passed).toBe(false);
  });
});

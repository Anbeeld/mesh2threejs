import { describe, test, expect } from "vitest";
import * as THREE from "three";
import { evaluateTankProfile } from "../src/profiles/tank.js";
import { auditCandidateSource } from "../src/core/candidate.js";
import { snapshotScene } from "../src/core/geometry.js";
import { createTankFixture, semanticMesh } from "./helpers/scenes.js";

function slabHullCandidate(): THREE.Group {
  const root = new THREE.Group();
  root.name = "slab-hull";
  root.userData.forwardAxis = "+z";
  for (let i = 0; i < 14; i++) {
    const slab = semanticMesh(`hull-${i}`, new THREE.BoxGeometry(3.2, 1.2, 0.4), [0, 0.4, -2.8 + i * 0.42]);
    root.add(slab);
  }
  root.add(semanticMesh("turret", new THREE.BoxGeometry(2.3, 0.9, 2.3), [0, 1.8, -0.25]));
  const pivot = new THREE.Group(); pivot.name = "turret-pivot"; pivot.userData.semanticId = "turret-pivot"; pivot.add(root.getObjectByName("turret")!);
  return root;
}

function boxTurretCandidate(): THREE.Group {
  const oracle = createTankFixture();
  const cand = createTankFixture();
  const turret = cand.getObjectByName("turret") as THREE.Mesh;
  turret.geometry.dispose();
  turret.geometry = new THREE.BoxGeometry(2.6, 0.9, 2.6);
  return cand;
}

function boxWheelCandidate(): THREE.Group {
  const cand = createTankFixture();
  for (const obj of [...cand.children]) {
    if (obj.name.startsWith("road-wheel")) {
      const m = obj as THREE.Mesh;
      const pos = m.position.clone();
      const box = semanticMesh(m.name, new THREE.BoxGeometry(1.1, 1.1, 0.22), [pos.x, pos.y, pos.z]);
      (box as any).userData.semanticRole = "road-wheel";
      cand.remove(m);
      cand.add(box);
    }
  }
  return cand;
}

describe("tank pipeline corrections", () => {
  test("canonical frame constant exported", async () => {
    const { TANK_CANONICAL_FRAME } = await import("../src/profiles/tank.js");
    expect(TANK_CANONICAL_FRAME.z).toBe("forward");
  });

  test("14 slab hull boxes fail hull sections/planes/contiguity", () => {
    const oracle = snapshotScene(createTankFixture());
    const candidateG = new THREE.Group();
    candidateG.name = "slab";
    candidateG.userData.forwardAxis = "+z";
    for (let i = 0; i < 14; i++) candidateG.add(semanticMesh(`hull-${i}`, new THREE.BoxGeometry(3.2, 1.2, 0.4), [0, 0.4, -2.8 + i * 0.45]));
    const candidate = snapshotScene(candidateG);
    const report = evaluateTankProfile(oracle, candidate, { certification: "oracle-relative" });
    const sections = report.rows.find((r) => r.code === "hull.sections");
    const contig = report.rows.find((r) => r.code === "hull.contiguity");
    expect(sections?.passed).toBe(false);
    expect(contig?.passed).toBe(false);
  });

  test("correct faceted hull passes hull sections", () => {
    const oracle = snapshotScene(createTankFixture());
    const candidate = snapshotScene(createTankFixture());
    const report = evaluateTankProfile(oracle, candidate, { certification: "oracle-relative" });
    expect(report.rows.find((r) => r.code === "hull.sections")?.passed).toBe(true);
    expect(report.rows.find((r) => r.code === "hull.contiguity")?.passed).toBe(true);
  });

  test("box wheel fails radiality, low-poly cylinder passes", () => {
    const oracle = snapshotScene(createTankFixture());
    const boxCand = snapshotScene(boxWheelCandidate());
    const boxReport = evaluateTankProfile(oracle, boxCand, { certification: "oracle-relative" });
    expect(boxReport.rows.find((r) => r.code === "running-gear.radiality")?.passed).toBe(false);

    const goodCand = snapshotScene(createTankFixture({ wheelSegments: 8 }));
    const goodReport = evaluateTankProfile(oracle, goodCand, { certification: "oracle-relative" });
    expect(goodReport.rows.find((r) => r.code === "running-gear.radiality")?.passed).toBe(true);
  });

  test("mirrored candidate fails orientation", () => {
    const oracle = snapshotScene(createTankFixture());
    const mirrored = snapshotScene(createTankFixture({ reverse: true }));
    const report = evaluateTankProfile(oracle, mirrored, { certification: "oracle-relative" });
    expect(report.rows.find((r) => r.code === "orientation.physical")?.passed).toBe(false);
  });

  test("candidate audit allows small control cage, rejects topology dump", () => {
    const small = "const pts = [0,0,0, 1,0,0, 1,1,0];\n".repeat(50);
    expect(auditCandidateSource(small).passed).toBe(true);
    const big = `const data = new Float32Array([${Array.from({ length: 6000 }, (_, i) => i % 2).join(",")}])`;
    expect(auditCandidateSource(big).findings.some((f) => f.code === "dense-binary-payload")).toBe(true);
  });

  test("fabrication checks hull-* prefixes", () => {
    const oracle = snapshotScene(createTankFixture());
    const candG = createTankFixture();
    candG.add(semanticMesh("hull-extra", new THREE.BoxGeometry(0.5, 0.5, 0.5), [0, 5, 0]));
    const cand = snapshotScene(candG);
    const report = evaluateTankProfile(oracle, cand, { certification: "oracle-relative" });
    expect(report.rows.find((r) => r.code === "fabrication.profile")).toBeDefined();
  });

  test("hull-only candidate has meaningful hull rows", () => {
    const oracle = snapshotScene(createTankFixture());
    const hullOnlyG = new THREE.Group();
    hullOnlyG.name = "hull-only";
    hullOnlyG.userData.forwardAxis = "+z";
    hullOnlyG.add(semanticMesh("hull", new THREE.BoxGeometry(3.2, 1.2, 6), [0, 0.4, 0]));
    hullOnlyG.add(semanticMesh("hull-upper", new THREE.BoxGeometry(2.8, 0.6, 3.8), [0, 1.25, -0.2]));
    const hullOnly = snapshotScene(hullOnlyG);
    const report = evaluateTankProfile(oracle, hullOnly, { certification: "oracle-relative" });
    expect(report.rows.some((r) => r.phase === "hull")).toBe(true);
  });
});

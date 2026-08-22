import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  evaluateGenericProfile,
  evaluateLowPolyStyle,
  evaluateTankProfile,
  lowPolyFaithful,
  regularPolygonFacetingCorridor,
  snapshotScene,
} from "../src/index.js";
import { createGenericFixture, createTankFixture, semanticMesh } from "./helpers/scenes.js";

describe("sibling subject profiles", () => {
  test("generic detects depth, handedness, attachment, and critical-feature failures", () => {
    const oracle = createGenericFixture();
    const report = evaluateGenericProfile(snapshotScene(oracle), snapshotScene(createGenericFixture({
      depth: 1,
      detached: true,
      mirrored: true,
      includeCritical: false,
    })));
    expect(report.profile).toBe("generic");
    expect(report.passed).toBe(false);
    expect(report.rows.map((row) => row.code)).toEqual(expect.arrayContaining([
      "dimensions.depth",
      "orientation.forward",
      "attachment.contiguity",
      "critical-feature.identity-fitting",
    ]));
  });

  test("tank catches seeded tank-specific defects with actionable rows", () => {
    const oracle = createTankFixture();
    const candidate = createTankFixture({ wheelRadius: 0.7, wheelShift: 0.2, turretShift: 0.35, gunLength: 2.6, hullSlope: 0.15, omitCupola: true });
    const report = evaluateTankProfile(snapshotScene(oracle), snapshotScene(candidate), {
      certification: "oracle-relative",
    });
    expect(report.profile).toBe("tank");
    expect(report.passed).toBe(false);
    expect(report.rows.map((row) => row.code)).toEqual(expect.arrayContaining([
      "curves.hull",
      "curves.whole",
      "curves.turret",
      "hull.station",
      "turret.placement",
      "gun.length",
      "running-gear.radius",
      "running-gear.spacing",
      "critical-feature.cupola",
      "fabrication.watertight",
      "floaters.articulation",
    ]));
    expect(report.workorders.some((item) => item.oracleValue !== undefined && item.candidateValue !== undefined)).toBe(true);
  });

  test("exact-real tank certification requires authoritative dimensions", () => {
    expect(() => evaluateTankProfile(snapshotScene(createTankFixture()), snapshotScene(createTankFixture()), {
      certification: "exact-real",
    })).toThrow(/authoritative dimensions/);
  });

  test.each([
    ["wrong orientation", { reverse: true }, "orientation.forward"],
    ["wrong wheel count", { omitWheel: true }, "running-gear.count"],
    ["wrong track course", { omitTrack: true }, "track.course"],
    ["floating turret fitting", { detachTurretItem: true }, "floaters.articulation"],
    ["open hull mass", { openHull: true }, "fabrication.watertight"],
  ] as const)("tank protected fixture catches %s", (_label, defect, code) => {
    const report = evaluateTankProfile(snapshotScene(createTankFixture()), snapshotScene(createTankFixture(defect)), { certification: "oracle-relative" });
    expect(report.rows.find((row) => row.code === code)?.passed).toBe(false);
  });

  test("generic fails closed when a required major semantic is renamed", () => {
    const candidate = createGenericFixture();
    candidate.getObjectByName("attachment")!.userData.semanticId = "unknown-part";
    const report = evaluateGenericProfile(snapshotScene(createGenericFixture()), snapshotScene(candidate));
    expect(report.rows.find((row) => row.code === "semantic.attachment")?.passed).toBe(false);
  });
});

describe("low-poly-faithful anti-gaming gate", () => {
  test("derives the analytical N-gon faceting corridor", () => {
    expect(regularPolygonFacetingCorridor(1, 10)).toBeCloseTo(1 - Math.cos(Math.PI / 10));
  });

  test("allows correct coarse curvature but rejects wrong radius and center", () => {
    const oracle = new THREE.Group();
    oracle.add(semanticMesh("wheel", new THREE.CylinderGeometry(1, 1, 0.4, 64)));
    const coarse = new THREE.Group();
    coarse.add(semanticMesh("wheel", new THREE.CylinderGeometry(1, 1, 0.4, 10)));
    const wrongRadius = new THREE.Group();
    wrongRadius.add(semanticMesh("wheel", new THREE.CylinderGeometry(1.2, 1.2, 0.4, 10)));
    const shifted = new THREE.Group();
    shifted.add(semanticMesh("wheel", new THREE.CylinderGeometry(1, 1, 0.4, 10), [0.2, 0, 0]));
    expect(evaluateLowPolyStyle(snapshotScene(oracle), snapshotScene(coarse), lowPolyFaithful).passed).toBe(true);
    expect(evaluateLowPolyStyle(snapshotScene(oracle), snapshotScene(wrongRadius), lowPolyFaithful).passed).toBe(false);
    expect(evaluateLowPolyStyle(snapshotScene(oracle), snapshotScene(shifted), lowPolyFaithful).passed).toBe(false);
  });

  test("does not let a lower triangle budget relax macro geometry", () => {
    const oracle = snapshotScene(createTankFixture());
    const wrong = snapshotScene(createTankFixture({ wheelSegments: 6, wheelRadius: 0.8 }));
    const contract = { ...lowPolyFaithful, complexity: { ...lowPolyFaithful.complexity, triangleMax: 100 } };
    const report = evaluateLowPolyStyle(oracle, wrong, contract);
    expect(report.passed).toBe(false);
    expect(report.rows.some((row) => row.code.includes("envelope"))).toBe(true);
  });

  test("allows a faithful faceted turret but rejects its wrong footprint", () => {
    const oracle = new THREE.Group();
    oracle.add(semanticMesh("turret", new THREE.CylinderGeometry(1, 1.2, 0.8, 64)));
    const faithful = new THREE.Group();
    faithful.add(semanticMesh("turret", new THREE.CylinderGeometry(1, 1.2, 0.8, 10)));
    const wrong = new THREE.Group();
    wrong.add(semanticMesh("turret", new THREE.CylinderGeometry(1.35, 1.55, 0.8, 10)));
    expect(evaluateLowPolyStyle(snapshotScene(oracle), snapshotScene(faithful), lowPolyFaithful).passed).toBe(true);
    expect(evaluateLowPolyStyle(snapshotScene(oracle), snapshotScene(wrong), lowPolyFaithful).passed).toBe(false);
  });

  test("allows omitted microdetail but never an omitted critical fitting", () => {
    const oracle = new THREE.Group();
    oracle.add(semanticMesh("body", new THREE.BoxGeometry(2, 2, 2)));
    oracle.add(semanticMesh("bolt", new THREE.BoxGeometry(0.01, 0.01, 0.01), [1, 0, 0]));
    oracle.add(semanticMesh("cupola", new THREE.BoxGeometry(0.4, 0.4, 0.4), [0, 1.2, 0], { critical: true }));
    const withoutBolt = new THREE.Group();
    withoutBolt.add(semanticMesh("body", new THREE.BoxGeometry(2, 2, 2)));
    withoutBolt.add(semanticMesh("cupola", new THREE.BoxGeometry(0.4, 0.4, 0.4), [0, 1.2, 0], { critical: true }));
    const withoutCupola = new THREE.Group();
    withoutCupola.add(semanticMesh("body", new THREE.BoxGeometry(2, 2, 2)));
    expect(evaluateLowPolyStyle(snapshotScene(oracle), snapshotScene(withoutBolt), lowPolyFaithful).passed).toBe(true);
    expect(evaluateLowPolyStyle(snapshotScene(oracle), snapshotScene(withoutCupola), lowPolyFaithful).passed).toBe(false);
  });
});

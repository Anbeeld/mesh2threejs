import * as THREE from "three";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  evaluateGenericProfile,
  evaluateCandidate,
  evaluateLowPolyStyle,
  evaluateTankProfile,
  lowPolyFaithful,
  regularPolygonFacetingCorridor,
  getProfileContract,
  runCli,
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
      "orientation.physical",
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
      "hull.stations",
      "turret.placement",
      "gun.geometry",
      "running-gear.instances",
      "running-gear.spacing",
      "critical-feature.cupola",
      "fabrication.profile",
      "ownership.seating",
    ]));
    expect(report.workorders.some((item) => item.oracleValue !== undefined && item.candidateValue !== undefined)).toBe(true);
  });

  test("exact-real tank certification requires authoritative dimensions", () => {
    expect(() => evaluateTankProfile(snapshotScene(createTankFixture()), snapshotScene(createTankFixture()), {
      certification: "exact-real",
    })).toThrow(/authoritative dimensions/);
    expect(() => evaluateTankProfile(snapshotScene(createTankFixture()), snapshotScene(createTankFixture()), {
      certification: "exact-real",
      authoritativeDimensions: { hullLength: 6 } as never,
    })).toThrow(/hullLength.*overallLength.*width.*height/);
  });

  test("exact-real generic evaluation consumes admitted dimensions", () => {
    const oracle = snapshotScene(createGenericFixture());
    expect(() => evaluateGenericProfile(oracle, oracle, {}, { certification: "exact-real" })).toThrow(/authoritative/);
    expect(() => evaluateGenericProfile(oracle, oracle, {}, { certification: "exact-real", authoritativeDimensions: { width: 4 } as never })).toThrow(/width.*height.*depth/);
    const bounds = { width: 5.5, height: 3, depth: 3 };
    const report = evaluateGenericProfile(oracle, snapshotScene(createGenericFixture({ depth: 1 })), {}, { certification: "exact-real", authoritativeDimensions: bounds });
    expect(report.rows.find((row) => row.code === "dimensions.depth")).toMatchObject({ oracleValue: 3, passed: false });
  });

  test("accepts an identical articulated tank as physically seated", () => {
    const report = evaluateTankProfile(snapshotScene(createTankFixture()), snapshotScene(createTankFixture()), {
      certification: "oracle-relative",
    });
    expect(report.rows.find((row) => row.code === "ownership.seating")?.passed).toBe(true);
  });

  test.each([
    ["wrong orientation", { reverse: true }, "orientation.physical"],
    ["wrong wheel count", { omitWheel: true }, "running-gear.count"],
    ["wrong track course", { omitTrack: true }, "track.course"],
    ["floating turret fitting", { detachTurretItem: true }, "ownership.seating"],
    ["open hull mass", { openHull: true }, "fabrication.profile"],
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

  test("uses declared directional landmarks and does not reject open planar references", () => {
    const planar = new THREE.Group();
    planar.add(semanticMesh("sheet", new THREE.PlaneGeometry(2, 3)));
    const planarReport = evaluateGenericProfile(snapshotScene(planar), snapshotScene(planar.clone(true)), { requiredSemantics: ["sheet"] });
    expect(planarReport.rows.find((row) => row.code === "orientation.physical")?.passed).toBe(true);
    expect(planarReport.rows.filter((row) => row.code.startsWith("silhouette.")).every((row) => row.passed)).toBe(true);

    const oracle = createGenericFixture();
    const reversed = createGenericFixture();
    reversed.getObjectByName("attachment")!.position.x *= -1;
    const report = evaluateGenericProfile(snapshotScene(oracle), snapshotScene(reversed), {
      orientation: { kind: "landmark-direction", from: "primary", to: "attachment", toleranceDegrees: 5 },
    });
    expect(report.rows.find((row) => row.code === "orientation.physical")?.passed).toBe(false);
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
    const oversmoothed = new THREE.Group();
    oversmoothed.add(semanticMesh("wheel", new THREE.CylinderGeometry(1, 1, 0.4, 32)));
    expect(evaluateLowPolyStyle(snapshotScene(oracle), snapshotScene(oversmoothed), lowPolyFaithful).rows.find((row) => row.code === "style.segments.wheel")?.passed).toBe(false);
  });

  test("does not let a lower triangle budget relax macro geometry", () => {
    const oracle = snapshotScene(createTankFixture());
    const wrong = snapshotScene(createTankFixture({ wheelSegments: 6, wheelRadius: 0.8 }));
    const contract = { ...lowPolyFaithful, complexity: { ...lowPolyFaithful.complexity, triangleMax: 100 } };
    const report = evaluateLowPolyStyle(oracle, wrong, contract);
    expect(report.passed).toBe(false);
    expect(report.rows.some((row) => row.code.includes("envelope"))).toBe(true);
  });

  test("recognizes the kit track course as explicitly faceted geometry", () => {
    const snapshot = snapshotScene(createTankFixture());
    expect(snapshot.components["track-1"]?.representation.flatOrFaceted).toBe(true);
    expect(evaluateLowPolyStyle(snapshot, snapshot, lowPolyFaithful).passed).toBe(true);
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

  test("enforces physical feature size only when an explicit semantic policy opts in", () => {
    const oracle = new THREE.Group();
    oracle.add(semanticMesh("body", new THREE.BoxGeometry(2, 2, 2)));
    oracle.add(semanticMesh("antenna-tip", new THREE.BoxGeometry(0.01, 0.01, 0.01), [0, 1.1, 0]));
    const candidate = oracle.clone(true);

    const withoutPolicy = evaluateLowPolyStyle(snapshotScene(oracle), snapshotScene(candidate), lowPolyFaithful);
    expect(withoutPolicy.rows.some((row) => row.code.startsWith("style.feature-size."))).toBe(false);

    const withPolicy = evaluateLowPolyStyle(snapshotScene(oracle), snapshotScene(candidate), {
      ...lowPolyFaithful,
      featureSizePolicy: { minimum: 0.05, unit: "object-unit", appliesTo: ["antenna-*"] },
    });
    expect(withPolicy.rows.find((row) => row.code === "style.feature-size.antenna-tip")).toMatchObject({
      passed: false,
      oracleValue: 0.05,
    });
  });

  test("assigns style work to the executable style phase", () => {
    const oracle = createGenericFixture();
    const contract = { ...lowPolyFaithful, complexity: { ...lowPolyFaithful.complexity, segmentRange: [6, 6] as [number, number] } };
    const evaluation = evaluateCandidate({ oracle, candidate: createGenericFixture(), profile: "generic", style: contract });
    expect(evaluation.style.rows.every((row) => row.phase === "style-complexity")).toBe(true);
    expect(evaluation.style.workorders.every((item) => item.phase === "style-complexity")).toBe(true);
    expect(evaluation.phaseGates["style-complexity"]?.passed).toBe(false);
    expect(evaluation.phaseGates["style-complexity"]?.rows.map((row) => row.code)).toEqual(expect.arrayContaining(["style.contract", "style.complexity"]));
  });

  test("makes segment and triangle limits prevent style-phase acceptance", () => {
    const oracle = createGenericFixture();
    const segments = evaluateCandidate({ oracle, candidate: createGenericFixture(), profile: "generic", style: { ...lowPolyFaithful, complexity: { ...lowPolyFaithful.complexity, segmentRange: [3, 3] } } });
    const triangles = evaluateCandidate({ oracle, candidate: createGenericFixture(), profile: "generic", style: { ...lowPolyFaithful, complexity: { ...lowPolyFaithful.complexity, triangleTarget: 1, triangleMax: 1 } } });
    expect(segments.phaseGates["style-complexity"]?.passed).toBe(false);
    expect(triangles.phaseGates["style-complexity"]?.passed).toBe(false);
    expect(getProfileContract("generic").phases.find((phase) => phase.id === "style-complexity")?.requiredGates).toEqual(expect.arrayContaining(["style.contract", "style.complexity"]));
    expect(getProfileContract("tank").phases.find((phase) => phase.id === "style-fabrication")?.requiredGates).toEqual(expect.arrayContaining(["fabrication.profile", "style.contract", "style.complexity"]));
  });

  test("returns style-derived workorders through the CLI for the active style phase", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-style-workorders-"));
    const reportPath = join(directory, "gate.json");
    const evaluation = evaluateCandidate({ oracle: createGenericFixture(), candidate: createGenericFixture(), profile: "generic", style: { ...lowPolyFaithful, complexity: { ...lowPolyFaithful.complexity, triangleTarget: 1, triangleMax: 1 } } });
    await writeFile(reportPath, JSON.stringify(evaluation));
    const output: string[] = [];
    expect(await runCli(["workorders", reportPath, "--phase", "style-complexity"], { stdout: (value) => output.push(value), stderr: (value) => output.push(value) })).toBe(0);
    expect(JSON.parse(output[0]!).workorders).toEqual(expect.arrayContaining([expect.objectContaining({ errorKind: "style.complexity.triangles", phase: "style-complexity" })]));
  });
});

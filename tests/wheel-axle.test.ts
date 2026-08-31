import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { measureWheelRadialProfile, snapshotScene, evaluateTankProfile } from "../src/index.js";

/**
 * Stage 2 regression (stylized-reconstruction plan §7): the tank running-gear evaluator must
 * judge wheel orientation against the canonical lateral axle X by robust geometry, not by the
 * vertex standard-deviation heuristic. A coarse fitted disc whose width exceeds half its
 * diameter flips the legacy minimum-spread axis to Y/Z and produced false "non-lateral axle"
 * and wrong-plane radial-profile failures on the real T-34 road wheels.
 */

const material = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: 0x6b7358, roughness: 0.7, flatShading: true });

/** X-axled faceted disc (cylinder geometry rotated Z 90°), optionally extruded along another axis. */
function wheel(semanticId: string, radius: number, width: number, sides: number, axle: "x" | "z" = "x", position: [number, number, number] = [1.3, 0.5, 0]): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(radius, radius, width, sides, 1, false).toNonIndexed();
  if (axle === "x") geometry.rotateZ(Math.PI / 2);
  if (axle === "z") geometry.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material());
  mesh.name = semanticId;
  mesh.userData.semanticId = semanticId;
  mesh.userData.semanticRole = "road-wheel";
  mesh.position.set(...position);
  return mesh;
}

function wheelScene(axles: Array<{ id: string; wheel: THREE.Mesh }>): THREE.Group {
  const root = new THREE.Group();
  root.name = "wheel-fixture";
  root.userData.forwardAxis = "+z";
  for (const { wheel: mesh } of axles) root.add(mesh);
  return root;
}

interface ProfileCheck {
  profile: NonNullable<ReturnType<typeof measureWheelRadialProfile>>;
}

const profileOf = (scene: THREE.Group, id: string, axle: 0 | 1 | 2): ProfileCheck => {
  const profile = measureWheelRadialProfile(snapshotScene(scene), id, 24, { expectedAxleAxis: axle });
  if (!profile) throw new Error(`no wheel profile for ${id}`);
  return { profile };
};

/** Tank running-gear rows for a two-wheel candidate against a dense oracle at the same placements. */
function runningGearRows(oracle: THREE.Group, candidate: THREE.Group): Map<string, boolean> {
  const report = evaluateTankProfile(snapshotScene(oracle), snapshotScene(candidate), { certification: "oracle-relative", phases: new Set(["running-gear"]) });
  return new Map(report.rows.filter((row) => row.code === "running-gear.radiality" || row.code === "running-gear.axles").map((row) => [row.code, row.passed]));
}

const oracleFixture = (): THREE.Group => wheelScene([
  { id: "road-wheel-1", wheel: semanticWheel("road-wheel-1", [1.3, 0.5, 0]) },
  { id: "road-wheel--1", wheel: semanticWheel("road-wheel--1", [-1.3, 0.5, 0]) },
]);

/** Dense oracle-like wheel (many segments with hub detail) at the canonical placement. */
function semanticWheel(id: string, position: [number, number, number]): THREE.Mesh {
  const mesh = wheel(id, 0.5, 0.24, 20, "x", position);
  return mesh;
}

describe("running-gear axle classification uses the canonical lateral axis (stage 2)", () => {
  test("wide coarse wheel beyond the legacy heuristic failure boundary still identifies X", () => {
    // Width 0.9 > 0.707 * diameter (1.0): the legacy vertex-spread inference flips to Y/Z.
    const scene = wheelScene([{ id: "road-wheel-1", wheel: wheel("road-wheel-1", 0.5, 0.9, 10) }]);
    const { profile } = profileOf(scene, "road-wheel-1", 0);
    expect(profile.axleAxis).toBe(0);
    expect(profile.axleAlignedWithX).toBe(true);
    expect(profile.radialRange, `radial range ${profile.radialRange} must stay inside the faceted corridor`).toBeLessThanOrEqual(0.2);
    expect(profile.circumferenceCoverage).toBeGreaterThanOrEqual(0.9);
    // Legacy inference demonstrably fails on this shape (mechanism documentation).
    const legacy = measureWheelRadialProfile(snapshotScene(scene), "road-wheel-1");
    expect(legacy?.axleAxis === 0 && legacy.axleAlignedWithX).toBe(false);
  });

  test("T-34-proportioned road wheel (width 0.609, diameter 0.812) passes tank evaluation", () => {
    const oracle = oracleFixture();
    const candidate = wheelScene([
      { id: "road-wheel-1", wheel: wheel("road-wheel-1", 0.406, 0.609, 12, "x", [1.3, 0.5, 0]) },
      { id: "road-wheel--1", wheel: wheel("road-wheel--1", 0.406, 0.609, 12, "x", [-1.3, 0.5, 0]) },
    ]);
    const rows = runningGearRows(oracle, candidate);
    expect(rows.get("running-gear.radiality"), "radiality must pass for the wide coarse wheel").toBe(true);
    expect(rows.get("running-gear.axles"), "axles must pass for the wide coarse wheel").toBe(true);
  });

  test("denser and thinner control wheels still pass", () => {
    const dense = wheelScene([{ id: "road-wheel-1", wheel: wheel("road-wheel-1", 0.5, 0.3, 16) }]);
    const { profile: denseProfile } = profileOf(dense, "road-wheel-1", 0);
    expect(denseProfile.axleAlignedWithX).toBe(true);
    expect(denseProfile.radialRange).toBeLessThanOrEqual(0.2);

    const thin = wheelScene([{ id: "road-wheel-1", wheel: wheel("road-wheel-1", 0.5, 0.1, 12) }]);
    const { profile: thinProfile } = profileOf(thin, "road-wheel-1", 0);
    expect(thinProfile.axleAlignedWithX).toBe(true);
    expect(thinProfile.radialRange).toBeLessThanOrEqual(0.2);

    // Tank evaluator rows with both controls.
    const oracle = oracleFixture();
    const candidate = wheelScene([
      { id: "road-wheel-1", wheel: wheel("road-wheel-1", 0.406, 0.4, 16, "x", [1.3, 0.5, 0]) },
      { id: "road-wheel--1", wheel: wheel("road-wheel--1", 0.406, 0.1, 12, "x", [-1.3, 0.5, 0]) },
    ]);
    const rows = runningGearRows(oracle, candidate);
    expect(rows.get("running-gear.radiality")).toBe(true);
    expect(rows.get("running-gear.axles")).toBe(true);
  });

  test("deliberately rotated non-lateral wheel still fails orientation", () => {
    const candidate = wheelScene([
      { id: "road-wheel-1", wheel: wheel("road-wheel-1", 0.406, 0.609, 12, "z", [1.3, 0.5, 0]) },
      { id: "road-wheel--1", wheel: wheel("road-wheel--1", 0.406, 0.609, 12, "x", [-1.3, 0.5, 0]) },
    ]);
    const candidateScene = candidate;
    const { profile } = profileOf(candidateScene, "road-wheel-1", 0);
    expect(profile.axleAlignedWithX).toBe(false);
    const oracle = oracleFixture();
    const rows = runningGearRows(oracle, candidate);
    expect(rows.get("running-gear.axles"), "axles row must reject the non-lateral wheel").toBe(false);
    // The rotated wheel also fails the radial profile measured in the canonical plane.
    expect(rows.get("running-gear.radiality")).toBe(false);
  });

  test("radial profile remains geometrically correct around the expected axle", () => {
    const scene = wheelScene([{ id: "road-wheel-1", wheel: wheel("road-wheel-1", 0.5, 0.9, 10) }]);
    const { profile } = profileOf(scene, "road-wheel-1", 0);
    // A 10-sided disc's in-plane radius is r; the profile mean stays close to it (edge sampling
    // includes the inscribed falloff), and coverage is complete.
    expect(profile.meanRadius).toBeGreaterThan(0.4);
    expect(profile.meanRadius).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(profile.circumferenceCoverage).toBe(1);
  });

  test("generic unconstrained inference is unchanged for dense geometry", () => {
    const dense = wheelScene([{ id: "road-wheel-1", wheel: wheel("road-wheel-1", 0.5, 0.24, 16) }]);
    const legacy = measureWheelRadialProfile(snapshotScene(dense), "road-wheel-1");
    expect(legacy?.axleAxis).toBe(0);
    expect(legacy?.axleAlignedWithX).toBe(true);
    const forced = measureWheelRadialProfile(snapshotScene(dense), "road-wheel-1", 24, { expectedAxleAxis: 0 });
    expect(forced?.radialRange).toBeCloseTo(legacy?.radialRange ?? -1, 6);
   expect(forced?.meanRadius).toBeCloseTo(legacy?.meanRadius ?? -1, 6);
  });
});
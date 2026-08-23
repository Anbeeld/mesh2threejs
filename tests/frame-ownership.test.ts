import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  loadPreparedOracle,
  onboardOracle,
  repairPreparedOracle,
  snapshotScene,
  sourceFrameTransform,
  verifyOracleRegistration,
  type OnboardOracleInput,
} from "../src/index.js";
import { createSlopedTank, sceneToGlb, stableSemanticIdentityMap } from "./helpers/tank-fixtures.js";

function wheelSemanticMap(): Record<string, string> {
  return stableSemanticIdentityMap(createSlopedTank());
}

/** Bakes every mesh's world transform and hoists it directly under one root: no pivot groups remain. */
function flattenScene(source: THREE.Object3D): THREE.Group {
  const flat = new THREE.Group();
  flat.name = "flat-source";
  source.updateMatrixWorld(true);
  for (const object of [...source.children]) {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const clone = new THREE.Mesh(mesh.geometry, mesh.material);
      clone.name = mesh.name;
      clone.userData = { ...mesh.userData };
      mesh.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
      flat.add(clone);
    });
  }
  return flat;
}

async function onboardTank(options: {
  forward?: "z" | "x";
  sourceFrame?: { right: "+x" | "-x" | "+y" | "-y" | "+z" | "-z"; up: "+x" | "-x" | "+y" | "-y" | "+z" | "-z"; forward: "+x" | "-x" | "+y" | "-y" | "+z" | "-z" };
  logicalOwnership?: Record<string, string>;
  flat?: boolean;
} = {}): Promise<{ manifest: Awaited<ReturnType<typeof onboardOracle>>; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-frame-"));
  const source = join(directory, "source.glb");
  const rotated = options.forward === "x";
  let tank: THREE.Object3D = createSlopedTank({ forward: options.forward ?? "z" });
  if (options.flat) tank = flattenScene(tank);
  await writeFile(source, sceneToGlb(tank, { includeRoot: rotated || Boolean(options.flat) }));
  const input: OnboardOracleInput = {
    id: "frame-fixture",
    sourcePath: source,
    preparedPath: join(directory, "prepared.json"),
    source: "self-authored analytical fixture",
    author: "mesh2threejs",
    license: "MIT",
    redistribution: "allowed",
    coordinateFrame: "right-handed",
    upAxis: "+y",
    forwardAxis: "+z",
    grounding: "min-y=0",
    scale: 1,
    semanticMap: stableSemanticIdentityMap(tank, { includeRoot: rotated || Boolean(options.flat) }),
    articulationMap: { gun: "gun-pivot", turret: "turret-pivot" },
    normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
    ...(options.sourceFrame ? { sourceFrame: options.sourceFrame } : {}),
    ...(options.logicalOwnership ? { logicalOwnership: options.logicalOwnership } : {}),
    authoritativeDimensions: null,
    dimensionSources: [],
  };
  return { manifest: await onboardOracle(input), directory };
}

const REGISTRATION_EXPECTATION = {
  forwardAxis: "+z",
  upAxis: "+y",
  expectedScale: 1,
  groundY: 0,
  requiredSemantics: ["hull", "turret", "gun"],
  requiredPivots: ["turret-pivot", "gun-pivot"],
  tolerance: 0.02,
};

describe("executable source frames", () => {
  test("declared frame maps role axes onto canonical axes", () => {
    const identity = sourceFrameTransform({ right: "+x", up: "+y", forward: "+z" }).matrix;
    expect(identity.elements.filter((value, index) => index % 4 !== 3 && ![0, 5, 10].includes(index)).every((value) => value === 0)).toBe(true);
    const rotated = sourceFrameTransform({ right: "-z", up: "+y", forward: "+x" }).matrix;
    const x = new THREE.Vector3(1, 0, 0).applyMatrix4(rotated);
    expect([x.x, x.y, x.z].map((value) => Math.round(value))).toEqual([0, 0, 1]);
  });

  test("contradictory and reflection-requiring frames fail closed before authority is written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-frame-invalid-"));
    const source = join(directory, "source.glb");
    await writeFile(source, sceneToGlb(createSlopedTank()));
    const base = {
      id: "invalid-frame", sourcePath: source, preparedPath: join(directory, "prepared.json"),
      source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
      coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
      semanticMap: {}, articulationMap: {},
      normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
      authoritativeDimensions: null, dimensionSources: [],
    } as OnboardOracleInput;
    await expect(onboardOracle({ ...base, sourceFrame: { right: "+x", up: "+x", forward: "+z" } })).rejects.toThrow(/distinct unsigned axes/i);
    await expect(onboardOracle({ ...base, sourceFrame: { right: "+y", up: "+x", forward: "+z" } })).rejects.toThrow(/reflection|handedness/i);
    await expect(readFile(join(directory, "prepared.json"))).rejects.toThrow();
  });

  test("X-longitudinal source canonicalizes through its declared frame and passes registration", async () => {
    const { manifest } = await onboardTank({ forward: "x", sourceFrame: { right: "-z", up: "+y", forward: "+x" } });
    const oracle = await loadPreparedOracle(manifest);
    const snapshot = snapshotScene(oracle);
    const wheels = Object.values(snapshot.components).filter((component) => component.role === "road-wheel");
    const zSpread = Math.max(...wheels.map((wheel) => wheel.bounds.center[2])) - Math.min(...wheels.map((wheel) => wheel.bounds.center[2]));
    const xSpread = Math.max(...wheels.map((wheel) => wheel.bounds.center[0])) - Math.min(...wheels.map((wheel) => wheel.bounds.center[0]));
    expect(zSpread).toBeGreaterThan(xSpread * 1.5);
    const registration = verifyOracleRegistration(oracle, REGISTRATION_EXPECTATION, { profile: "tank" });
    expect(registration.rows.filter((row) => !row.passed).map((row) => row.code)).toEqual([]);
  });

  test("the same X-longitudinal source without a valid transform fails the mandatory tank frame proof", async () => {
    const { manifest } = await onboardTank({ forward: "x" });
    const oracle = await loadPreparedOracle(manifest);
    const registration = verifyOracleRegistration(oracle, REGISTRATION_EXPECTATION, { profile: "tank" });
    const failed = registration.rows.filter((row) => !row.passed).map((row) => row.code);
    expect(failed).toContain("registration.frame.longitudinal");
    expect(registration.passed).toBe(false);
  });

  test("tank frame proofs are scoped to the tank profile and pivot origins come from real pivot anchors", async () => {
    const { manifest } = await onboardTank({ forward: "x" });
    const oracle = await loadPreparedOracle(manifest);
    // The same X-longitudinal oracle under a generic profile needs no tank frame proofs.
    const genericRegistration = verifyOracleRegistration(oracle, { ...REGISTRATION_EXPECTATION, requiredSemantics: [], requiredPivots: [] }, { profile: "generic" });
    expect(genericRegistration.rows.some((row) => row.code.startsWith("registration.frame."))).toBe(false);
    expect(genericRegistration.passed).toBe(true);
  });
});

describe("logical ownership overlay", () => {
  test("genuinely flat GLB (no pivot groups) with ownership overlay measures as logically nested after load and repair", async () => {
    const ownership = { turret: "turret-pivot", cupola: "turret-pivot", gun: "gun-pivot", hull: "root" };
    const { manifest } = await onboardTank({ logicalOwnership: ownership, flat: true });
    const assertOverlay = async (candidateManifest: typeof manifest): Promise<void> => {
      const oracle = await loadPreparedOracle(candidateManifest);
      const snapshot = snapshotScene(oracle);
      // Every mesh sits directly under the root node in the GLB; only the overlay expresses nesting.
      expect(snapshot.components.turret?.parentSemanticId).toBe("turret-pivot");
      expect(snapshot.components.cupola?.parentSemanticId).toBe("turret-pivot");
      expect(snapshot.components.gun?.parentSemanticId).toBe("gun-pivot");
      expect(snapshot.components.hull?.parentSemanticId).toBe("root");
    };
    await assertOverlay(manifest);
    const repairedPath = join(await mkdtemp(join(tmpdir(), "mesh2threejs-own-repair-")), "prepared-repaired.json");
    const repaired = await repairPreparedOracle(manifest, { reason: "confirm mapping only", preparedPath: repairedPath });
    expect(repaired.logicalOwnership).toEqual(ownership);
    await assertOverlay(repaired);
  });

  test("repair preserves a declared source frame", async () => {
    const { manifest } = await onboardTank({ forward: "x", sourceFrame: { right: "-z", up: "+y", forward: "+x" } });
    const repairedPath = join(await mkdtemp(join(tmpdir(), "mesh2threejs-frame-repair-")), "prepared-repaired.json");
    const repaired = await repairPreparedOracle(manifest, { reason: "mapping confirmation only", preparedPath: repairedPath });
    expect(repaired.sourceFrame).toEqual({ right: "-z", up: "+y", forward: "+x" });
    const oracle = await loadPreparedOracle(repaired);
    expect(verifyOracleRegistration(oracle, REGISTRATION_EXPECTATION, { profile: "tank" }).passed).toBe(true);
  });

  test("forbidden ownership graphs are rejected at onboarding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-own-invalid-"));
    const source = join(directory, "source.glb");
    await writeFile(source, sceneToGlb(createSlopedTank()));
    const base = {
      id: "invalid-ownership", sourcePath: source, preparedPath: join(directory, "prepared.json"),
      source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
      coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
      semanticMap: wheelSemanticMap(),
      articulationMap: { gun: "gun-pivot", turret: "turret-pivot" },
      normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
      authoritativeDimensions: null, dimensionSources: [],
    } as OnboardOracleInput;
    await expect(onboardOracle({ ...base, logicalOwnership: { hull: "turret-pivot" } })).rejects.toThrow(/hull cannot be owned/i);
    await expect(onboardOracle({ ...base, logicalOwnership: { "track--1": "gun-pivot" } })).rejects.toThrow(/owned by gun-pivot/i);
    await expect(onboardOracle({ ...base, logicalOwnership: { gun: "turret" } })).rejects.toThrow(/gun must remain under gun-pivot/i);
    await expect(onboardOracle({ ...base, logicalOwnership: { hull: "root", missing: "hull" } })).resolves.toBeDefined();
    await expect(onboardOracle({ ...base, logicalOwnership: { hull: "nowhere-pivot" } })).rejects.toThrow(/does not resolve/i);
  });
});

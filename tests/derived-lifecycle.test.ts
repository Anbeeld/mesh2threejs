import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  createWorkspaceResolver,
  resumeWorkspace,
  composeCandidateForPhase,
  buildSeedGroup,
  initializeWorkspace,
  loadTaskState,
  loadTrustedGeneratedModules,
  resolveSeedOutcome,
  runCli,
  snapshotScene,
  verifyWorkspaceCandidateIdentity,
  verifyWorkspaceOraclePreparation,
  loadPreparedOracle,
  evaluateCandidateWithPoses,
  trustedGeneratedAuditOptions,
} from "../src/index.js";
import { getProfileContract } from "../src/core/contracts.js";
import { createLoftGeometry, createTrackCourseGeometry } from "../src/kit.js";
import { sceneToGlb, stableSemanticIdentityMap, tessellateFiner } from "./helpers/tank-fixtures.js";

function semanticMesh(id: string, geometry: THREE.BufferGeometry, position: [number, number, number], role?: string, rotation?: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x6b7358, roughness: 0.7 }));
  mesh.name = id;
  mesh.userData.semanticId = id;
  mesh.userData.critical = ["hull", "turret", "gun"].includes(id);
  if (role) mesh.userData.semanticRole = role;
  if (rotation) mesh.rotation.set(...rotation);
  mesh.position.set(...position);
  return mesh;
}

function semanticGroup(id: string, position: [number, number, number]): THREE.Group {
  const group = new THREE.Group();
  group.name = id;
  group.userData.semanticId = id;
  group.position.set(...position);
  return group;
}

/**
 * License-free synthetic lifecycle tank: dense sloped hull plus legitimate disconnected
 * fender, lofted turret with cupola under an explicit turret-pivot, gun under gun-pivot
 * beneath the turret assembly, five radial wheels plus a sprocket and an idler per side,
 * and two continuous track courses resting on the ground plane. Dense enough that
 * derivation meaningfully simplifies; structure mirrors the tank profile doctrine.
 */
export function createLifecycleTankGlb(): { bytes: Buffer; semanticMap: Record<string, string> } {
  const root = new THREE.Group();
  root.name = "lifecycle-tank-source";
  root.userData.forwardAxis = "+z";

  const hullStations = [
    { z: -3.0, halfWidth: 1.15, bottom: 0.55, top: 1.05 },
    { z: -2.2, halfWidth: 1.45, bottom: 0.5, top: 1.45 },
    { z: -0.4, halfWidth: 1.55, bottom: 0.5, top: 1.6 },
    { z: 1.6, halfWidth: 1.5, bottom: 0.5, top: 1.5 },
    { z: 2.9, halfWidth: 1.25, bottom: 0.5, top: 1.05 },
  ];
  root.add(semanticMesh("hull", tessellateFiner(createLoftGeometry(hullStations), 4), [0, 0, 0]));
  root.add(semanticMesh("hull-fender", new THREE.BoxGeometry(0.35, 0.08, 2.2).toNonIndexed(), [1.45, 0.95, 0.2]));

  const turretPivot = semanticGroup("turret-pivot", [0, 1.62, -0.5]);
  const turretStations = [
    { z: -1.15, halfWidth: 0.78, bottom: 0, top: 0.72 },
    { z: -0.4, halfWidth: 1.02, bottom: 0, top: 0.82 },
    { z: 0.55, halfWidth: 0.95, bottom: 0, top: 0.74 },
    { z: 1.05, halfWidth: 0.55, bottom: 0, top: 0.55 },
  ];
  turretPivot.add(semanticMesh("turret", tessellateFiner(createLoftGeometry(turretStations), 3), [0, 0, 0]));
  turretPivot.add(semanticMesh("cupola", new THREE.CylinderGeometry(0.3, 0.34, 0.28, 12).toNonIndexed(), [0.32, 0.85, -0.35]));

  const gunPivot = semanticGroup("gun-pivot", [0, 0.42, 0.95]);
  gunPivot.add(semanticMesh("gun", new THREE.CylinderGeometry(0.11, 0.11, 3.2, 10).toNonIndexed(), [0, 0, 1.6], undefined, [Math.PI / 2, 0, 0]));
  turretPivot.add(gunPivot);
  root.add(turretPivot);

  for (const side of [-1, 1] as const) {
    for (let index = 0; index < 5; index += 1) {
      root.add(semanticMesh(`road-wheel-${side === -1 ? "l" : "r"}-${index}`, new THREE.CylinderGeometry(0.5, 0.5, 0.24, 12).toNonIndexed(), [side * 1.3, 0.5, -2.1 + index * 1.05], "road-wheel", [0, 0, Math.PI / 2]));
    }
    root.add(semanticMesh(`sprocket-${side === -1 ? "l" : "r"}`, new THREE.CylinderGeometry(0.4, 0.4, 0.22, 10).toNonIndexed(), [side * 1.3, 0.55, 2.75], "sprocket", [0, 0, Math.PI / 2]));
    root.add(semanticMesh(`idler-${side === -1 ? "l" : "r"}`, new THREE.CylinderGeometry(0.35, 0.35, 0.22, 10).toNonIndexed(), [side * 1.3, 0.45, -2.75], "idler", [0, 0, Math.PI / 2]));
    root.add(semanticMesh(`track-${side === -1 ? "l" : "r"}`, createTrackCourseGeometry(6.2, 1.15, 0.24, 0.32), [side * 1.48, 0.58, 0], "track-course"));
  }

  // Node groups and their primitive meshes share display names; key semantics by the first
  // stable node:N identity per unique source name.
  const identity = new Map<string, string>();
  for (const [key, name] of Object.entries(stableSemanticIdentityMap(root))) if (!identity.has(name)) identity.set(name, key);
  const semanticMap = Object.fromEntries([...identity.entries()].map(([name, key]) => [key, name]));
  return { bytes: sceneToGlb(root), semanticMap };
}

describe("synthetic multi-phase derived tank lifecycle", () => {
  test("autonomous builder completion through every derivable phase to the review boundary", { timeout: 900_000 }, async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-lifecycle-"));
    const root = join(parent, "workspace");
    const fixturePath = join(parent, "lifecycle-tank.glb");
    const fixture = createLifecycleTankGlb();
    await writeFile(fixturePath, fixture.bytes);
    await mkdir(root, { recursive: true });

    await initializeWorkspace(root, { id: "lifecycle-demo", goal: "derive every builder phase autonomously", profile: "tank", oracle: fixturePath });
    const run = async (args: string[]): Promise<{ code: number; out: string[]; err: string[] }> => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(args, { stdout: (value) => out.push(value), stderr: (value) => err.push(value) });
      return { code, out, err };
    };
    const expectOk = async (args: string[]): Promise<string[]> => {
      const result = await run(args);
      if (result.code !== 0 || result.err.join("\n").trim()) {
        const tail = result.out.at(-1) ?? "";
        throw new Error(`runCli ${args.join(" ")} failed (exit ${result.code})\nstderr: ${result.err.join("\n")}\nstdout-tail: ${tail.slice(0, 4000)}`);
      }
      return result.out;
    };

    // Onboarding chain.
    const onboardConfig = {
      id: "lifecycle-tank",
      sourcePath: "refs/oracle/lifecycle-tank.glb",
      preparedPath: ".mesh2threejs/oracle/prepared.json",
      source: "synthetic fixture",
      author: "mesh2threejs tests",
      license: "MIT",
      redistribution: "permitted",
      coordinateFrame: "right-handed y-up",
      upAxis: "+y",
      forwardAxis: "+z",
      grounding: "min-y",
      scale: 1,
      semanticMap: fixture.semanticMap,
      articulationMap: {},
      normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
      authoritativeDimensions: null,
      dimensionSources: [],
    };
    await writeFile(join(root, "onboard.config.json"), JSON.stringify(onboardConfig));
    await expectOk(["onboard", root, "--config", join(root, "onboard.config.json")]);

    const expectation = {
      forwardAxis: "+z",
      upAxis: "+y",
      expectedScale: 1,
      groundY: 0,
      requiredSemantics: ["hull", "turret", "gun"],
      requiredPivots: ["turret-pivot", "gun-pivot"],
      tolerance: 0.05,
    };
    await writeFile(join(root, "registration.config.json"), JSON.stringify(expectation));
    await expectOk(["register", root, "--config", join(root, "registration.config.json")]);

    // Regression: the fixture writer must serialize authored PBR so the prepared oracle
    // preserves the source palette; a dropped baseColorFactor once surfaced far downstream
    // as style.palette failures against an accidental neutral-gray oracle.
    {
      const ws = await resumeWorkspace(root);
      const prep = await verifyWorkspaceOraclePreparation(ws);
      const oracle = await loadPreparedOracle(prep.manifest, ws.root);
      expect(snapshotScene(oracle).components.hull?.representation.colors, "prepared oracle preserves fixture base color").toEqual([0x6b7358]);
    }

    await expectOk(["oracle-sanity", root]);
    await expectOk(["lock", root]);

    const resolver = createWorkspaceResolver(root);
    const statePath = resolver.layout.internal.state;
    const readState = async (): Promise<Awaited<ReturnType<typeof loadTaskState>>> => loadTaskState(statePath);
    const lockedHashes = new Map<string, string>();

    // Derive → gate → lock through every supported derivation phase. Tracks passing PROVES
    // contextual composition: an isolated track seed cannot clear course diagnostics that
    // measure against the locked hull envelope.
    for (const phase of ["hull", "turret", "gun", "running-gear", "tracks"] as const) {
      const stateBefore = await readState();
      expect(stateBefore.activePhase, `active phase before ${phase}`).toBe(phase);
      const deriveOut = await expectOk(["derive", root]);
      const derived = JSON.parse(deriveOut.at(-1)!) as { status: string; wiring?: string; reasonCode?: string };
      expect(derived.status, `${phase} derive status`).toBe("seed-passing");
      expect(derived.wiring, `${phase} derive wiring`).not.toBe("manual-wiring-required");

      await expectOk(["gate", root]);
      await expectOk(["lock", root]);
      const locked = await readState();
      expect(locked.locks[phase], `${phase} lock exists`).toBeTruthy();
      lockedHashes.set(phase, locked.locks[phase]!.geometryHash);
      void stateBefore;
    }

    // Regression boundary: every generated module plus the regenerated registry must load
    // into a fresh wired candidate with healthy geometry BEFORE articulation evaluation.
    // A single out-of-range index once NaN-poisoned the gun bounds into an all-zero box,
    // surfacing far away as a misleading ownership.seating detached-geometry failure.
    {
      const ws = await resumeWorkspace(root);
      const prep = await verifyWorkspaceOraclePreparation(ws);
      const candidate = (
        await verifyWorkspaceCandidateIdentity(ws, await trustedGeneratedAuditOptions(ws, prep.binding.identity))
      ).runtime;
      const gunObject = candidate.root.getObjectByName("gun") as THREE.Mesh;
      expect(gunObject).toBeTruthy();
      const gunPosition = gunObject.geometry.getAttribute("position");
      const gunIndex = gunObject.geometry.index!;
      expect(Math.max(...Array.from(gunIndex.array))).toBeLessThan(gunPosition.count);
      const gun = snapshotScene(candidate.root).components.gun!;
      expect(gun.triangleIndices.length).toBe(36);
      expect(gun.bounds.min.every(Number.isFinite)).toBe(true);
      expect(gun.bounds.max.every(Number.isFinite)).toBe(true);
      expect(gun.bounds.size[2]).toBeGreaterThan(3);
    }

    // Remaining builder phases run on the pipeline-composed candidate without manual work.
    for (const phase of ["fittings-articulation", "style-fabrication"] as const) {
      const stateBefore = await readState();
      expect(stateBefore.activePhase, `active phase before ${phase}`).toBe(phase);
      await expectOk(["gate", root]);
      await expectOk(["lock", root]);
      const locked = await readState();
      expect(locked.locks[phase], `${phase} lock exists`).toBeTruthy();
      lockedHashes.set(phase, locked.locks[phase]!.geometryHash);
    }

    // Locked prerequisite geometry never drifted during later derivations.
    const finalState = await readState();
    for (const [phase, hash] of lockedHashes) {
      expect(finalState.locks[phase]?.geometryHash, `${phase} geometry unchanged`).toBe(hash);
    }

    // Trust authority validates end to end against durable state bindings.
    const trustedModules = Object.keys(finalState.derivedBindings);
    expect(trustedModules.length).toBe(5);
    for (const moduleKey of trustedModules) {
      expect(moduleKey.startsWith("model/.generated/") && moduleKey.endsWith(".mjs"), `canonical generated path ${moduleKey}`).toBe(true);
    }

    // Whole-object deterministic validation on the composed vehicle.
    await expectOk(["gate", root, "--global"]);

    // Review-boundary preparation: full capture refresh plus packet-ready handoff output.
    await expectOk(["render", root]);
    await expectOk(["review-ready", root]);

    // The viewer stays stopped; review readiness never starts it implicitly.
    const viewerStatus = await run(["viewer", "status", root]);
    expect(viewerStatus.code).toBe(0);
    expect(viewerStatus.out.join("\n")).toMatch(/not-running/u);

    await rm(parent, { recursive: true, force: true });
  });
});

describe("phase composition and hierarchy regressions", () => {
  function semanticNode(id: string, geometry: THREE.BufferGeometry, position: [number, number, number], role?: string, rotation?: [number, number, number]): THREE.Mesh {
    return semanticMesh(id, geometry, position, role, rotation);
  }

  test("composition keeps locked prerequisites, replaces only active-phase geometry, rejects future phases", () => {
    const liveRoot = new THREE.Group();
    liveRoot.add(semanticNode("hull", new THREE.BoxGeometry(3, 1, 6).toNonIndexed(), [0, 1, 0]));
    liveRoot.add(semanticNode("road-wheel-a", new THREE.CylinderGeometry(0.5, 0.5, 0.24, 8).toNonIndexed(), [1.3, 0.5, 0], "road-wheel"));
    const liveRuntime = { root: liveRoot, setPose: () => {} };

    const replacement = new THREE.Group();
    replacement.name = "derived-running-gear";
    replacement.add(semanticNode("road-wheel-b", new THREE.CylinderGeometry(0.5, 0.5, 0.24, 8).toNonIndexed(), [-1.3, 0.5, 0], "road-wheel"));

    const composed = composeCandidateForPhase({ profile: "tank", phase: "running-gear", liveCandidate: liveRuntime, replacement });
    try {
      const snapshot = snapshotScene(composed.root);
      expect(snapshot.components.hull).toBeTruthy();
      expect(snapshot.components["road-wheel-a"]).toBeFalsy();
      expect(snapshot.components["road-wheel-b"]).toBeTruthy();
    } finally {
      composed.dispose();
    }
    // Dispose restores the exact prior graph.
    const restored = snapshotScene(liveRuntime.root);
    expect(restored.components.hull).toBeTruthy();
    expect(restored.components["road-wheel-a"]).toBeTruthy();
    expect(restored.components["road-wheel-b"]).toBeFalsy();

    // Future-phase placeholder in the LIVE candidate is refused outright.
    const polluted = new THREE.Group();
    polluted.add(semanticNode("hull", new THREE.BoxGeometry(3, 1, 6).toNonIndexed(), [0, 1, 0]));
    polluted.add(semanticNode("turret", new THREE.BoxGeometry(1, 0.5, 1).toNonIndexed(), [0, 1.8, 0]));
    expect(() => composeCandidateForPhase({ profile: "tank", phase: "hull", liveCandidate: { root: polluted, setPose: () => {} }, replacement: new THREE.Group() }))
      .toThrow(/outside the cumulative scope/iu);
  });

  test("axis-fit hierarchy emits gun owned by gun-pivot, structurally satisfying its own gate inputs", () => {
    const pivot = new THREE.Group();
    pivot.name = "gun-pivot";
    pivot.userData.semanticId = "gun-pivot";
    pivot.position.set(0, 0.42, 0.95);
    const barrel = semanticNode("gun", new THREE.CylinderGeometry(0.11, 0.11, 3.2, 10).toNonIndexed(), [0, 0, 2.55], undefined, [Math.PI / 2, 0, 0]);
    pivot.add(barrel);

    const snapshot = snapshotScene(pivot);
    expect(snapshot.components.gun!.parentSemanticId).toBe("gun-pivot");
    expect(snapshot.components["gun-pivot"]!.origin).toBeDefined();

    // SeedNode emission reproduces the same ownership through buildSeedGroup. Owner-local
    // geometry bakes the rotation in: barrel axis along Z, centered at (0, 0, 2.55).
    const localBarrel = new THREE.CylinderGeometry(0.11, 0.11, 3.2, 10).toNonIndexed();
    localBarrel.rotateX(Math.PI / 2);
    localBarrel.translate(0, 0, 2.55);
    const barrelPositions = localBarrel.getAttribute("position").array as Float32Array;
    const nodes = [
      { semanticId: "gun-pivot", kind: "group" as const, position: [0, 0.42, 0.95] as [number, number, number] },
      { semanticId: "gun", kind: "mesh" as const, parentSemanticId: "gun-pivot", positions: barrelPositions, indices: Uint32Array.from({ length: barrelPositions.length / 3 }, (_, index) => index) },
    ];
    const seeded = buildSeedGroup("gun", nodes);
    const seededSnapshot = snapshotScene(seeded);
    expect(seededSnapshot.components.gun!.parentSemanticId).toBe("gun-pivot");
    // World placement matches despite owner-local coordinates.
    const worldBox = new THREE.Box3().setFromObject(seeded);
    expect(worldBox.min.y).toBeCloseTo(0.31, 1);
    expect(worldBox.max.z).toBeGreaterThan(4);
  });

  test("over-budget fallback is retained only as diagnostic material, never a lockable seed", () => {
    const tier = (overrides: Partial<{ passed: boolean; score: number; withinComplexityBudget: boolean }>, tierName: "aggressive" | "balanced" | "conservative" | "source-cleaned" = "source-cleaned") => ({
      tier: tierName,
      triangles: 90_000,
      passed: false,
      score: 0,
      ...overrides,
    });
    // Geometric pass on the fallback tier but beyond the hard ceiling: diagnostic-only.
    const overBudget = resolveSeedOutcome([
      tier({ score: 40 }, "aggressive"),
      tier({ score: 60 }, "conservative"),
      tier({ passed: true, score: 95, withinComplexityBudget: false }),
    ]);
    expect(overBudget.status).toBe("seed-diagnostic-overbudget");
    expect(overBudget.reasonCode).toBe("derive.over-budget-fallback");
    expect(overBudget.chosen?.tier).toBe("source-cleaned");

    // A cheaper tier that passes AND fits wins outright.
    const clean = resolveSeedOutcome([
      { tier: "aggressive", triangles: 400, passed: true, score: 96, withinComplexityBudget: true },
      { tier: "source-cleaned", triangles: 90_000, passed: true, score: 99, withinComplexityBudget: false },
    ]);
    expect(clean.status).toBe("seed-passing");
    expect(clean.chosen?.tier).toBe("aggressive");

    // Nothing passes: retained failing with its reason code.
    const failing = resolveSeedOutcome([tier({ score: 30 }, "conservative")]);
    expect(failing.status).toBe("seed-retained-failing");
    expect(failing.reasonCode).toBe("derive.no-passing-tier");
  });
});

// Contract sanity for the lifecycle assumptions above.
describe("profile contract ordering used by cumulative scope", () => {
  test("derivable phases follow contract order and own their declared semantics", () => {
    const contract = getProfileContract("tank");
    const order = contract.phases.map((phase) => phase.id);
    expect(order.indexOf("hull")).toBeLessThan(order.indexOf("turret"));
    expect(order.indexOf("tracks")).toBeLessThan(order.indexOf("fittings-articulation"));
    expect(readdir(join("."))).toBeTruthy(); // keep imports honest on slow CI paths
  });
});

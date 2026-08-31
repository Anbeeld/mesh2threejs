import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  createWorkspaceResolver,
  derivePhaseSeed,
  initializeWorkspace,
  loadTaskState,
  resumeWorkspace,
  runCli,
  saveTaskState,
  snapshotScene,
  trustedGeneratedAuditOptions,
  verifyWorkspaceCandidateIdentity,
  verifyWorkspaceOraclePreparation,
  loadPreparedOracle,
} from "../src/index.js";
import { createLoftGeometry } from "../src/kit.js";
import { sceneToGlb, stableSemanticIdentityMap, tessellateFiner } from "./helpers/tank-fixtures.js";
import type { TaskState } from "../src/core/state.js";

/**
 * Bundle A5 contract tests (pipeline remediation plan §5.A5, bundle E): `component-keep`
 * must have a precise, tested meaning — never a schema-accepted inert operation (evidence E4).
 *
 * Implemented contract:
 * 1. keep(target) requires target to be an oracle semantic OWNED BY THE ACTIVE PHASE with
 *    intrinsic triangles; anything else fails derive clearly (never silently succeeds).
 * 2. On mesh-simplify phases, keep prevents insignificant-island pruning for the targeted
 *    semantic (kept islands flow through simplification instead of being dropped).
 * 3. Keep never bypasses complexity ceilings, style gates, ownership, or repair ceilings:
 *    kept geometry joins the trial composition and its budget accounting like any other.
 * 4. On the axis-fit gun phase, keep(gun-pivot) intentionally preserves source geometry
 *    intrinsically owned by the pivot: emitted as a child mesh of the pivot group WITHOUT a
 *    duplicate semanticId, so the runtime snapshot attributes it to the pivot semantic while
 *    the pivot remains a transform anchor.
 */

const material = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: 0x6b7358, roughness: 0.7, flatShading: true });

function semanticMesh(id: string, geometry: THREE.BufferGeometry, position: [number, number, number], rotation?: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material());
  mesh.name = id;
  mesh.userData.semanticId = id;
  if (rotation) mesh.rotation.set(...rotation);
  mesh.position.set(...position);
  return mesh;
}

function hullGroupWithTinyIsland(): THREE.Group {
  const root = new THREE.Group();
  root.name = "keep-hull-source";
  root.userData.forwardAxis = "+z";
  const group = new THREE.Group();
  group.name = "hull";
  group.userData.semanticId = "hull";
  const stations = [
    { z: -3.0, halfWidth: 1.15, bottom: 0.55, top: 1.05 },
    { z: -2.2, halfWidth: 1.45, bottom: 0.5, top: 1.45 },
    { z: -0.4, halfWidth: 1.55, bottom: 0.5, top: 1.6 },
    { z: 1.6, halfWidth: 1.5, bottom: 0.5, top: 1.5 },
    { z: 2.9, halfWidth: 1.25, bottom: 0.5, top: 1.05 },
  ];
  const main = new THREE.Mesh(tessellateFiner(createLoftGeometry(stations), 4), material());
  main.name = "hull-main";
  group.add(main);
  // Tiny detached island: area and diagonal far below BOTH prune thresholds
  // (area < 0.5% of total, diagonal < 5% of the max island diagonal).
  const tiny = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1).toNonIndexed(), material());
  tiny.name = "hull-insignificant-island";
  tiny.position.set(4.5, 3, -2.5);
  group.add(tiny);
  root.add(group);
  return root;
}

function gunFixture(): THREE.Group {
  const root = new THREE.Group();
  root.name = "keep-gun-source";
  root.userData.forwardAxis = "+z";
  root.add(semanticMesh("hull", new THREE.BoxGeometry(3.2, 1.2, 6), [0, 0.4, 0]));
  const turretPivot = new THREE.Group();
  turretPivot.name = "turret-pivot";
  turretPivot.userData.semanticId = "turret-pivot";
  turretPivot.position.set(0, 1.8, -0.25);
  turretPivot.add(semanticMesh("turret", new THREE.CylinderGeometry(1.15, 1.3, 0.9, 12).toNonIndexed(), [0, 0, 0], [Math.PI / 2, 0, 0]));
  root.add(turretPivot);
  const gunPivot = new THREE.Group();
  gunPivot.name = "gun-pivot";
  gunPivot.userData.semanticId = "gun-pivot";
  gunPivot.position.set(0, 1.8, 0.55);
  // Pivot-OWNED collar: unnamed child mesh, attributed to the gun-pivot semantic.
  const collar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.4).toNonIndexed(), material());
  collar.name = "gun-collar";
  gunPivot.add(collar);
  // Barrel: semantic gun mesh in pivot-local coordinates, base at the pivot.
  const barrelGeometry = new THREE.CylinderGeometry(0.12, 0.12, 3.4, 10).toNonIndexed();
  barrelGeometry.rotateX(Math.PI / 2);
  barrelGeometry.translate(0, 0, 1.7);
  gunPivot.add(semanticMesh("gun", barrelGeometry, [0, 0, 0]));
  turretPivot.add(gunPivot);
  return root;
}

async function createDerivedWorkspace(fixtureRoot: THREE.Group, semanticIds: string[], options: { requiredSemantics: string[]; requiredPivots: string[]; groundY: number }): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-keep-"));
  const root = join(parent, "workspace");
  await mkdir(join(root, "refs", "oracle"), { recursive: true });
  const glb = sceneToGlb(fixtureRoot);
  await writeFile(join(root, "refs", "oracle", "fixture.glb"), glb);
  await initializeWorkspace(root, { id: "keep-demo", goal: "component-keep contract regression", profile: "tank" });

  const run = async (args: string[]): Promise<void> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { stdout: (value) => out.push(value), stderr: (value) => err.push(value) });
    if (code !== 0) throw new Error(`runCli ${args.join(" ")} exited ${code}: ${err.join("\n") || out.join("\n")}`);
  };
  const identities = stableSemanticIdentityMap(fixtureRoot);
  const semanticMap: Record<string, string> = {};
  for (const [key, name] of Object.entries(identities)) if (semanticIds.includes(name)) semanticMap[key] = name;
  const onboardConfig = {
    id: "keep-fixture",
    sourcePath: "refs/oracle/fixture.glb",
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
    semanticMap,
    articulationMap: {},
    normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
    authoritativeDimensions: null,
    dimensionSources: [],
  };
  const onboardPath = join(root, "onboard.config.json");
  await writeFile(onboardPath, JSON.stringify(onboardConfig));
  await run(["onboard", root, "--config", onboardPath]);
  const expectation = {
    forwardAxis: "+z",
    upAxis: "+y",
    expectedScale: 1,
    groundY: options.groundY,
    requiredSemantics: options.requiredSemantics,
    requiredPivots: options.requiredPivots,
    tolerance: 0.05,
  };
  const expectationPath = join(root, "registration.config.json");
  await writeFile(expectationPath, JSON.stringify(expectation));
  await run(["register", root, "--config", expectationPath]);
  await run(["oracle-sanity", root]);
  await run(["lock", root]);
  return root;
}

async function activatePhase(root: string, phase: string): Promise<void> {
  const statePath = createWorkspaceResolver(root).layout.internal.state;
  const state = await loadTaskState(statePath);
  const next = { ...state, activePhase: phase, phaseStatus: { ...state.phaseStatus, [phase]: "active" as const } } as TaskState;
  await saveTaskState(statePath, next);
}

async function writeRepair(root: string, phase: string, operations: Array<Record<string, unknown>>): Promise<void> {
  await mkdir(join(root, "model", "repairs"), { recursive: true });
  await writeFile(join(root, "model", "repairs", `${phase}.json`), `${JSON.stringify({ schemaVersion: 1, phase, operations }, null, 2)}\n`);
}

const generatedModule = (root: string, phase: string): Promise<string> => readFile(join(root, "model", ".generated", `${phase}.mjs`), "utf8");

describe("component-keep contract (bundle E)", () => {
  test("keep prevents insignificant-island pruning on a mesh-simplify phase", async () => {
    const withKeep = await createDerivedWorkspace(hullGroupWithTinyIsland(), ["hull"], { requiredSemantics: ["hull"], requiredPivots: [], groundY: 0.5 });
    const withoutKeep = await createDerivedWorkspace(hullGroupWithTinyIsland(), ["hull"], { requiredSemantics: ["hull"], requiredPivots: [], groundY: 0.5 });
    try {
      // Baseline: the tiny island is pruned from the seed.
      const baseResult = await derivePhaseSeed(withoutKeep);
      expect(baseResult.status).toBeDefined();
      const baseModule = await generatedModule(withoutKeep, "hull");
      expect(baseModule).not.toContain("4.55");
      const baseManifest = JSON.parse(await readFile(join(withoutKeep, ".mesh2threejs", "derived", "hull.json"), "utf8")) as { outputTriangles: number };

      // With keep: the insignificant island belonging to the targeted semantic survives.
      await writeRepair(withKeep, "hull", [{ op: "component-keep", target: "hull" }]);
      const keepResult = await derivePhaseSeed(withKeep);
      expect(keepResult.status).toBeDefined();
      const keepModule = await generatedModule(withKeep, "hull");
      expect(keepModule).toContain("4.55");
      const keepManifest = JSON.parse(await readFile(join(withKeep, ".mesh2threejs", "derived", "hull.json"), "utf8")) as { outputTriangles: number };
      // The kept island joins the budget accounting: the output grows by the tiny box's 12
      // triangles minus at most a few main-island budget-shift triangles (the kept island
      // slightly reduces the main island's proportional simplification share) — never free,
      // never bypassing the complexity accounting.
      const delta = keepManifest.outputTriangles - baseManifest.outputTriangles;
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThanOrEqual(12);
    } finally {
      await rm(join(withKeep, ".."), { recursive: true, force: true });
      await rm(join(withoutKeep, ".."), { recursive: true, force: true });
    }
  }, 300_000);

  test("kept geometry stays inside complexity accounting and gate evaluation (no bypass)", async () => {
    const root = await createDerivedWorkspace(hullGroupWithTinyIsland(), ["hull"], { requiredSemantics: ["hull"], requiredPivots: [], groundY: 0.5 });
    try {
      await writeRepair(root, "hull", [{ op: "component-keep", target: "hull" }]);
      const result = await derivePhaseSeed(root);
      // Tiers were still evaluated (gate scores present) and the kept island counts in the
      // reported triangle totals rather than bypassing the budget.
      expect(result.tiers.length).toBeGreaterThan(0);
      expect(result.tiers[0]!.triangles).toBeGreaterThan(0);
      const keepModule = await generatedModule(root, "hull");
      expect(keepModule).toContain("4.55");
    } finally {
      await rm(join(root, ".."), { recursive: true, force: true });
    }
  }, 300_000);

  test("unknown or foreign keep targets fail derive clearly", async () => {
    const unknownTarget = await createDerivedWorkspace(hullGroupWithTinyIsland(), ["hull"], { requiredSemantics: ["hull"], requiredPivots: [], groundY: 0.5 });
    const foreignTarget = await createDerivedWorkspace(hullGroupWithTinyIsland(), ["hull"], { requiredSemantics: ["hull"], requiredPivots: [], groundY: 0.5 });
    try {
      await writeRepair(unknownTarget, "hull", [{ op: "component-keep", target: "does-not-exist" }]);
      await expect(derivePhaseSeed(unknownTarget)).rejects.toThrow(/component-keep.*does-not-exist/iu);
      await writeRepair(foreignTarget, "hull", [{ op: "component-keep", target: "turret" }]);
      await expect(derivePhaseSeed(foreignTarget)).rejects.toThrow(/component-keep.*turret/iu);
    } finally {
      await rm(join(unknownTarget, ".."), { recursive: true, force: true });
      await rm(join(foreignTarget, ".."), { recursive: true, force: true });
    }
  }, 300_000);

  test("keep(gun-pivot) preserves pivot-owned source geometry; the pivot remains a transform group", async () => {
    const root = await createDerivedWorkspace(gunFixture(), ["hull", "turret", "turret-pivot", "gun", "gun-pivot"], { requiredSemantics: ["hull", "turret", "gun"], requiredPivots: ["turret-pivot", "gun-pivot"], groundY: -0.2 });
    try {
      await activatePhase(root, "gun");
      await writeRepair(root, "gun", [{ op: "component-keep", target: "gun-pivot" }]);
      const result = await derivePhaseSeed(root);
      expect(result.operator).toBe("axis-fit");
      const moduleSource = await generatedModule(root, "gun");
      // Pivot stays a semantic transform anchor group.
      expect(moduleSource).toContain(`pivotGroup.userData.semanticId = "gun-pivot"`);
      // The kept collar is emitted as a child mesh of the pivot WITHOUT a duplicate semanticId.
      expect(moduleSource).toContain(`mesh.name = "gun-pivot-intrinsic"`);
      const semanticIdCount = moduleSource.split("userData.semanticId").length - 1;
      expect(semanticIdCount).toBe(2); // gun-pivot group + gun mesh only
      // Collar geometry is pivot-local around the pivot origin.
      expect(moduleSource).toContain("group.getObjectByName(\"gun-pivot\")");

      // End-to-end: load the composed generated candidate and measure intrinsically.
      const ws = await resumeWorkspace(root);
      const prep = await verifyWorkspaceOraclePreparation(ws);
      const oracle = await loadPreparedOracle(prep.manifest, ws.root);
      const oracleSnapshot = snapshotScene(oracle);
      expect(oracleSnapshot.components["gun-pivot"]!.triangleIndices.length).toBeGreaterThan(0);
      const runtime = (await verifyWorkspaceCandidateIdentity(ws, await trustedGeneratedAuditOptions(ws, prep.binding.identity))).runtime;
      const candidateSnapshot = snapshotScene(runtime.root);
      const pivot = candidateSnapshot.components["gun-pivot"]!;
      expect(pivot.triangleIndices.length, "kept collar geometry attributed to the pivot semantic").toBeGreaterThan(0);
      expect(pivot.bounds.size[0]).toBeCloseTo(0.5, 3);
      expect(pivot.bounds.size[2]).toBeCloseTo(0.4, 3);
      expect(pivot.origin).toBeDefined();
      // The pivot object itself is still a transform Group, not a mesh.
      const pivotObject = runtime.root.getObjectByName("gun-pivot")!;
      expect((pivotObject as THREE.Mesh).isMesh).toBeFalsy();
      // Barrel unchanged and still owned by the pivot.
      expect(candidateSnapshot.components.gun!.parentSemanticId).toBe("gun-pivot");
      expect(candidateSnapshot.components.gun!.bounds.size[2]).toBeCloseTo(3.4, 2);
    } finally {
      await rm(join(root, ".."), { recursive: true, force: true });
    }
  }, 300_000);

  test("inapplicable keep markers fail clearly instead of silently succeeding", async () => {
    // keep(gun) on the axis-fit phase: gun geometry is fitted unconditionally; the marker
    // can never affect the seed.
    const gunTarget = await createDerivedWorkspace(gunFixture(), ["hull", "turret", "turret-pivot", "gun", "gun-pivot"], { requiredSemantics: ["hull", "turret", "gun"], requiredPivots: ["turret-pivot", "gun-pivot"], groundY: -0.2 });
    // keep(gun-pivot) when the pivot owns NO intrinsic triangles: nothing to preserve.
    const barePivotSpec = gunFixture();
    barePivotSpec.getObjectByName("gun-pivot")!.remove(barePivotSpec.getObjectByName("gun-collar")!);
    const barePivot = await createDerivedWorkspace(barePivotSpec, ["hull", "turret", "turret-pivot", "gun", "gun-pivot"], { requiredSemantics: ["hull", "turret", "gun"], requiredPivots: ["turret-pivot", "gun-pivot"], groundY: -0.2 });
    try {
      await activatePhase(gunTarget, "gun");
      await writeRepair(gunTarget, "gun", [{ op: "component-keep", target: "gun" }]);
      await expect(derivePhaseSeed(gunTarget)).rejects.toThrow(/component-keep.*gun\b/iu);

      await activatePhase(barePivot, "gun");
      await writeRepair(barePivot, "gun", [{ op: "component-keep", target: "gun-pivot" }]);
      await expect(derivePhaseSeed(barePivot)).rejects.toThrow(/component-keep.*gun-pivot/iu);
    } finally {
      await rm(join(gunTarget, ".."), { recursive: true, force: true });
      await rm(join(barePivot, ".."), { recursive: true, force: true });
    }
  }, 300_000);
});

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  createTaskState,
  createWorkspaceResolver,
  derivePhaseSeed,
  initializeWorkspace,
  loadTaskState,
  reopenPhase,
  getProfileContract,
  resumeWorkspace,
  runCli,
  saveTaskState,
} from "../src/index.js";
import { reconcileDerivedWorkspaceFromBindings } from "../src/core/derive.js";
import { GENERATED_DIRECTORY, GENERATED_REGISTRY_PATH, MODEL_DERIVED_SCAFFOLD, orderedDerivedPhasesFromBindings, generateRegistrySource } from "../src/core/derivation.js";
import { createLoftGeometry } from "../src/kit.js";
import { sceneToGlb, stableSemanticIdentityMap, tessellateFiner } from "./helpers/tank-fixtures.js";
import type { DerivedBinding, TaskState } from "../src/core/state.js";

/**
 * Bundle A2/A3 regressions (pipeline remediation plan §5.A2/A3).
 *
 * A2: reopening a phase follows CONTRACT ORDER. Reopening phase i invalidates the
 * contract-order suffix phases[i:], not merely the dependsOn descendants. Dependency
 * closure and the executable contract prefix used by phaseWithPrerequisites() are
 * different lifecycle models; the reopen transition must match the composition model
 * (evidence E5), and generated composition authority must be pruned with it (evidence E6).
 *
 * A3: generated composition derives from canonical state.derivedBindings only. Stale
 * derivation manifests / generated modules left on disk after a reopen can never
 * re-enter composition or trusted-module authority.
 */

const binding = (seed: string): DerivedBinding => ({
  manifestHash: `manifest-${seed}`,
  generatedModuleHash: `module-${seed}`,
  oraclePreparationIdentity: "prep-1",
});

/** A tank state locked through `tracks` with generated bindings for every derivable phase. */
function tankStateLockedThroughTracks(): TaskState {
  const state = createTaskState({ taskId: "reopen-regression", profile: "tank", style: "low-poly-faithful", authorshipMode: "derived" });
  const order = getProfileContract("tank").phases.map((phase) => phase.id);
  const locked = ["oracle-registration", "hull", "turret", "gun", "running-gear", "tracks"];
  for (const phase of order) {
    if (locked.includes(phase)) {
      state.locks[phase] = {
        phase,
        geometryHash: `geometry-${phase}`,
        evidence: [],
        oracleHash: "oracle-1",
        candidateHash: "candidate-1",
        contractHash: state.profileContractHash,
        acceptedAt: new Date().toISOString(),
      };
      state.phaseStatus[phase] = "passed";
    }
  }
  state.phaseGeometryHashes["hull"] = "geometry-hull";
  state.activePhase = "fittings-articulation";
  state.phaseStatus["fittings-articulation"] = "active";
  state.oracleHash = "oracle-1";
  state.candidateHash = "candidate-1";
  state.derivedBindings = {
    "model/.generated/hull.mjs": binding("hull"),
    "model/.generated/turret.mjs": binding("turret"),
    "model/.generated/gun.mjs": binding("gun"),
    "model/.generated/running-gear.mjs": binding("running-gear"),
    "model/.generated/tracks.mjs": binding("tracks"),
    "model/repairs/hull.json": binding("repair-hull"),
  };
  return state;
}

describe("reopen invalidates the contract-order suffix (A2)", () => {
  test("reopen turret: hull stays locked, everything from turret onward is invalidated", () => {
    const state = tankStateLockedThroughTracks();
    const next = reopenPhase(state, "turret", "remediation regression");
    const suffix = ["turret", "gun", "running-gear", "tracks", "fittings-articulation", "style-fabrication", "visual-review", "final"];

    // Preserved: oracle-registration and hull.
    expect(next.locks["oracle-registration"]).toBeTruthy();
    expect(next.locks.hull).toBeTruthy();
    expect(next.phaseStatus.hull).toBe("passed");
    expect(next.reopens[0]?.invalidated).toEqual(suffix);

    // Active: turret. Invalidated/unlocked: the whole suffix.
    expect(next.activePhase).toBe("turret");
    expect(next.phaseStatus.turret).toBe("active");
    for (const phase of suffix) {
      expect(next.locks[phase], `${phase} lock must be released`).toBeUndefined();
      if (phase !== "turret") expect(next.phaseStatus[phase], `${phase} status`).toBe("invalidated");
    }

    // Generated module bindings remain only for still-valid derivable phases; repair
    // JSON bindings survive (repair specs are user-authored input, decision D5).
    expect(Object.keys(next.derivedBindings).sort()).toEqual(["model/.generated/hull.mjs", "model/repairs/hull.json"]);
  });

  test("reopen hull: all downstream builder composition is removed", () => {
    const state = tankStateLockedThroughTracks();
    const next = reopenPhase(state, "hull", "hull redo");
    expect(next.locks["oracle-registration"]).toBeTruthy();
    expect(Object.keys(next.locks).sort()).toEqual(["oracle-registration"]);
    expect(next.activePhase).toBe("hull");
    expect(Object.keys(next.derivedBindings).sort()).toEqual(["model/repairs/hull.json"]);
  });

  test("reopen tracks: earlier hull/turret/gun/running-gear remain", () => {
    const state = tankStateLockedThroughTracks();
    const next = reopenPhase(state, "tracks", "track redo");
    expect(Object.keys(next.locks).sort()).toEqual(["gun", "hull", "oracle-registration", "running-gear", "turret"]);
    expect(next.activePhase).toBe("tracks");
    expect(Object.keys(next.derivedBindings).sort()).toEqual(["model/.generated/gun.mjs", "model/.generated/hull.mjs", "model/.generated/running-gear.mjs", "model/.generated/turret.mjs", "model/repairs/hull.json"]);
  });

  test("reopen leaves earlier-phase evidence valid and invalidates suffix evidence", () => {
    const state = tankStateLockedThroughTracks();
    state.evidence["hull-gate"] = {
      id: "hull-gate", kind: "deterministic-gate", phase: "hull", artifact: "hull.json", passed: true,
      oracleHash: "oracle-1", candidateHash: "candidate-1", valid: true, createdAt: new Date().toISOString(),
    };
    state.evidence["tracks-gate"] = {
      id: "tracks-gate", kind: "deterministic-gate", phase: "tracks", artifact: "tracks.json", passed: true,
      oracleHash: "oracle-1", candidateHash: "candidate-1", valid: true, createdAt: new Date().toISOString(),
    };
    const next = reopenPhase(state, "turret", "evidence check");
    expect(next.evidence["hull-gate"]?.valid).toBe(true);
    expect(next.evidence["tracks-gate"]?.valid).toBe(false);
  });

  test("reopen of an unlocked phase is refused", () => {
    const state = tankStateLockedThroughTracks();
    expect(() => reopenPhase(state, "fittings-articulation", "not locked")).toThrow(/not locked/i);
  });
});

describe("generated composition authority derives from canonical bindings (A3)", () => {
  test("ordered phases come from bindings only; stale phases never enter the registry source", () => {
    const bindings: Record<string, DerivedBinding> = {
      "model/.generated/hull.mjs": binding("hull"),
      "model/repairs/hull.json": binding("repair-hull"),
    };
    const ordered = orderedDerivedPhasesFromBindings("tank", bindings);
    expect(ordered).toEqual(["hull"]);
    const registry = generateRegistrySource("tank", ordered);
    expect(registry).toContain('./hull.mjs');
    expect(registry).not.toContain("turret.mjs");
    expect(registry).not.toContain("tracks.mjs");
    expect(registry).not.toContain("gun.mjs");
  });

  test("a registry carrying stale invalidated phase imports is a lineage violation", async () => {
    const bindings: Record<string, DerivedBinding> = { "model/.generated/hull.mjs": binding("hull") };
    // The stale registry still imports the invalidated turret phase — as it would on disk
    // after a reopen that only pruned state bindings.
    const staleRegistry = generateRegistrySource("tank", ["hull", "turret"]);
    const { verifyDerivedLineage, MODEL_DERIVED_SCAFFOLD } = await import("../src/core/derivation.js");
    const { mkdtemp, writeFile, mkdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "mesh2threejs-stale-registry-"));
    try {
      await mkdir(join(root, "model", ".generated"), { recursive: true });
      await writeFile(join(root, "model", "model.mjs"), MODEL_DERIVED_SCAFFOLD);
      await writeFile(join(root, "model", ".generated", "registry.mjs"), staleRegistry);
      await expect(verifyDerivedLineage({
        modelEntryPath: join(root, "model", "model.mjs"),
        workspaceRoot: root,
        profile: "tank",
        authorshipMode: "derived",
        derivedBindings: bindings,
        trustedModules: new Map(),
      })).rejects.toThrow(/registry does not match trusted derive state/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** Minimal hull-only derived fixture for derive-level reopen integration. */
function hullOnlyFixture(): { root: THREE.Group; semanticIds: string[] } {
  const root = new THREE.Group();
  root.name = "reopen-hull-source";
  root.userData.forwardAxis = "+z";
  const mesh = new THREE.Mesh(tessellateFiner(createLoftGeometry([
    { z: -3.0, halfWidth: 1.15, bottom: 0.55, top: 1.05 },
    { z: -2.2, halfWidth: 1.45, bottom: 0.5, top: 1.45 },
    { z: -0.4, halfWidth: 1.55, bottom: 0.5, top: 1.6 },
    { z: 1.6, halfWidth: 1.5, bottom: 0.5, top: 1.5 },
    { z: 2.9, halfWidth: 1.25, bottom: 0.5, top: 1.05 },
  ]), 4), new THREE.MeshStandardMaterial({ color: 0x6b7358, flatShading: true }));
  mesh.name = "hull";
  root.add(mesh);
  return { root, semanticIds: ["hull"] };
}

async function createHullDerivedWorkspace(): Promise<string> {
  const fixture = hullOnlyFixture();
  const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-reopen-derive-"));
  const root = join(parent, "workspace");
  await mkdir(join(root, "refs", "oracle"), { recursive: true });
  await writeFile(join(root, "refs", "oracle", "fixture.glb"), sceneToGlb(fixture.root));
  await initializeWorkspace(root, { id: "reopen-derive", goal: "reopen lifecycle regression", profile: "tank" });
  const run = async (args: string[]): Promise<void> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { stdout: (value) => out.push(value), stderr: (value) => err.push(value) });
    if (code !== 0) throw new Error(`runCli ${args.join(" ")} exited ${code}: ${err.join("\n") || out.join("\n")}`);
  };
  const semanticMap: Record<string, string> = {};
  for (const [key, name] of Object.entries(stableSemanticIdentityMap(fixture.root))) if (fixture.semanticIds.includes(name)) semanticMap[key] = name;
  const onboardConfig = {
    id: "reopen-fixture", sourcePath: "refs/oracle/fixture.glb", preparedPath: ".mesh2threejs/oracle/prepared.json",
    source: "synthetic fixture", author: "mesh2threejs tests", license: "MIT", redistribution: "permitted",
    coordinateFrame: "right-handed y-up", upAxis: "+y", forwardAxis: "+z", grounding: "min-y", scale: 1,
    semanticMap, articulationMap: {}, normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
    authoritativeDimensions: null, dimensionSources: [],
  };
  const onboardPath = join(root, "onboard.config.json");
  await writeFile(onboardPath, JSON.stringify(onboardConfig));
  await run(["onboard", root, "--config", onboardPath]);
  const expectationPath = join(root, "registration.config.json");
  await writeFile(expectationPath, JSON.stringify({ forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0.5, requiredSemantics: ["hull"], requiredPivots: [], tolerance: 0.05 }));
  await run(["register", root, "--config", expectationPath]);
  await run(["oracle-sanity", root]);
  await run(["lock", root]);
  const result = await derivePhaseSeed(root);
  expect(result.phase).toBe("hull");
  return root;
}

async function writeStaleDerivedArtifacts(root: string, phase: string, moduleSource: string): Promise<void> {
  await mkdir(join(root, GENERATED_DIRECTORY), { recursive: true });
  await writeFile(join(root, GENERATED_DIRECTORY, `${phase}.mjs`), moduleSource);
  const manifestDirectory = join(root, ".mesh2threejs", "derived");
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(join(manifestDirectory, `${phase}.json`), `${JSON.stringify({
    schemaVersion: 1, kind: "mesh2threejs-derived-seed", phase,
    oraclePreparationIdentity: "stale-identity", preparedOracleHash: "0".repeat(64),
    operator: "mesh-simplify", recipe: { tier: "stale" }, inputGeometryHash: "0".repeat(64),
    outputGeometryHash: "0".repeat(64), generatedModulePath: `${GENERATED_DIRECTORY}/${phase}.mjs`,
    generatedModuleHash: "0".repeat(64), inputTriangles: 1, outputTriangles: 1,
  }, null, 2)}
`);
}

describe("derive and reconciliation follow the post-reopen binding ledger (C3/C4)", () => {
  test("derive cannot resurrect invalidated phases from stale manifests or modules on disk", async () => {
    const root = await createHullDerivedWorkspace();
    try {
      expect((await loadTaskState(createWorkspaceResolver(root).layout.internal.state)).derivedBindings["model/.generated/hull.mjs"]).toBeTruthy();

      // Lock hull (as gate+lock would), then reach the canonical post-reopen state through
      // the REAL transition: contract suffix invalidation plus generated-binding pruning.
      const statePath = createWorkspaceResolver(root).layout.internal.state;
      const derived = await loadTaskState(statePath);
      derived.locks.hull = { phase: "hull", geometryHash: "geometry-hull", evidence: [], oracleHash: derived.oracleHash ?? "unbound", candidateHash: derived.candidateHash ?? "unbound", contractHash: derived.profileContractHash, acceptedAt: new Date().toISOString() };
      derived.phaseStatus.hull = "passed";
      await saveTaskState(statePath, derived);
      const reopened = reopenPhase(await loadTaskState(statePath), "hull", "reopen lifecycle regression");
      await saveTaskState(statePath, reopened);
      expect(reopened.derivedBindings["model/.generated/hull.mjs"]).toBeUndefined();

      // Stale invalidated artifacts reappear on disk (as they would after any reopen that
      // only updated canonical state) and the on-disk registry still imports them.
      await writeStaleDerivedArtifacts(root, "turret", "export function createSeed() { return new THREE.Group(); }\n");
      const staleRegistry = generateRegistrySource("tank", ["hull", "turret"]);
      await writeFile(join(root, GENERATED_REGISTRY_PATH), staleRegistry);

      // Re-derive: composition must come from the post-reopen binding ledger ONLY.
      const result = await derivePhaseSeed(root);
      expect(result.phase).toBe("hull");
      const registry = await readFile(join(root, GENERATED_REGISTRY_PATH), "utf8");
      expect(registry).toContain("./hull.mjs");
      expect(registry).not.toContain("turret.mjs");
      const state = await loadTaskState(statePath);
      expect(Object.keys(state.derivedBindings)).toEqual(["model/.generated/hull.mjs"]);
    } finally {
      await rm(join(root, ".."), { recursive: true, force: true });
    }
  }, 300_000);

  test("reconcileDerivedWorkspaceFromBindings prunes stale artifacts and is idempotent", async () => {
    const root = await createHullDerivedWorkspace();
    try {
      const statePath = createWorkspaceResolver(root).layout.internal.state;
      const derived = await loadTaskState(statePath);
      derived.locks.hull = { phase: "hull", geometryHash: "geometry-hull", evidence: [], oracleHash: derived.oracleHash ?? "unbound", candidateHash: derived.candidateHash ?? "unbound", contractHash: derived.profileContractHash, acceptedAt: new Date().toISOString() };
      derived.phaseStatus.hull = "passed";
      await saveTaskState(statePath, derived);
      const reopened = reopenPhase(await loadTaskState(statePath), "hull", "reconcile regression");
      await saveTaskState(statePath, reopened);
      await writeStaleDerivedArtifacts(root, "turret", "export function createSeed() { return new THREE.Group(); }\n");
      const workspace = await resumeWorkspace(root);
      const state = await loadTaskState(statePath);

      await reconcileDerivedWorkspaceFromBindings(workspace, state);
      // Reopening hull pruned the hull generated binding too (contract suffix from hull),
      // so reconcile must leave ONLY the regenerated (empty) registry: no phase modules,
      // no derivation manifests, and the stale turret artifacts are gone.
      const moduleNames = await readdir(join(root, GENERATED_DIRECTORY));
      expect(moduleNames).toEqual(["registry.mjs"]);
      const manifestNames = await readdir(join(root, ".mesh2threejs", "derived"));
      expect(manifestNames).toEqual([]);
      expect(state.derivedBindings).toEqual({});
      const registry = await readFile(join(root, GENERATED_REGISTRY_PATH), "utf8");
      expect(registry).toBe(generateRegistrySource("tank", orderedDerivedPhasesFromBindings("tank", state.derivedBindings)));

      // Idempotent: rerunning leaves the exact same bytes.
      await reconcileDerivedWorkspaceFromBindings(workspace, state);
      expect(await readFile(join(root, GENERATED_REGISTRY_PATH), "utf8")).toBe(registry);
    } finally {
      await rm(join(root, ".."), { recursive: true, force: true });
    }
  }, 300_000);
});

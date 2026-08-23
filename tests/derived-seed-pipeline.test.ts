import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  auditCandidateModule,
  createTaskState,
  createWorkspaceResolver,
  derivePhaseSeed,
  evaluateTankProfile,
  initializeWorkspace,
  loadTaskState,
  loadTrustedGeneratedModules,
  saveTaskState,
  snapshotScene,
  verifyOracleRegistration,
  assertPhaseSemanticScope,
  runCli,
  determineNextAction,
} from "../src/index.js";
import { createLoftGeometry } from "../src/kit.js";
import { sceneToGlb, stableSemanticIdentityMap, tessellateFiner } from "./helpers/tank-fixtures.js";

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function semanticMesh(id: string, geometry: THREE.BufferGeometry, position: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x6b7358, roughness: 0.7 }));
  mesh.name = id;
  mesh.userData.semanticId = id;
  mesh.position.set(...position);
  return mesh;
}

/** License-free synthetic dense hull: sloped planes, dense coplanar tessellation, legitimate disconnected fender. */
function denseHullFixture(): { bytes: Buffer; semanticMap: Record<string, string> } {
  const root = new THREE.Group();
  root.name = "dense-hull-source";
  const stations = [
    { z: -3.0, halfWidth: 1.15, bottom: 0.55, top: 1.05 },
    { z: -2.2, halfWidth: 1.45, bottom: 0.5, top: 1.45 },
    { z: -0.4, halfWidth: 1.55, bottom: 0.5, top: 1.6 },
    { z: 1.6, halfWidth: 1.5, bottom: 0.5, top: 1.5 },
    { z: 2.9, halfWidth: 1.25, bottom: 0.5, top: 1.05 },
  ];
  root.add(semanticMesh("hull", tessellateFiner(createLoftGeometry(stations), 5), [0, 0, 0]));
  root.add(semanticMesh("hull-fender", new THREE.BoxGeometry(0.35, 0.08, 2.2).toNonIndexed(), [1.45, 0.95, 0.2]));
  // Node groups and their auto-named primitive meshes share display names; key the semantic
  // map by the first stable node:N identity per unique source name.
  const identity = new Map<string, string>();
  for (const [key, name] of Object.entries(stableSemanticIdentityMap(root))) if (!identity.has(name)) identity.set(name, key);
  const semanticMap = Object.fromEntries([...identity.entries()].map(([name, key]) => [key, name]));
  return { bytes: sceneToGlb(root), semanticMap };
}

async function createDerivedWorkspace(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-derived-"));
  const root = join(parent, "workspace");
  await mkdir(join(root, "refs", "oracle"), { recursive: true });
  const fixture = denseHullFixture();
  await writeFile(join(root, "refs", "oracle", "dense-hull.glb"), fixture.bytes);
  await initializeWorkspace(root, { id: "derived-demo", goal: "derive the hull seed from the prepared oracle", profile: "tank" });

  // Real onboarding chain: onboard -> register -> oracle-sanity -> lock registration.
  const run = async (args: string[]): Promise<void> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, { stdout: (value) => out.push(value), stderr: (value) => err.push(value) });
    if (code !== 0) throw new Error(`runCli ${args.join(" ")} exited ${code}: ${err.join("\n") || out.join("\n")}`);
  };
  const onboardConfig = {
    id: "dense-hull",
    sourcePath: "refs/oracle/dense-hull.glb",
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
  const onboardPath = join(root, "onboard.config.json");
  await writeFile(onboardPath, JSON.stringify(onboardConfig));
  await run(["onboard", root, "--config", onboardPath]);

  const expectation = {
    forwardAxis: "+z",
    upAxis: "+y",
    expectedScale: 1,
    groundY: 0.5,
    requiredSemantics: ["hull"],
    requiredPivots: [],
    tolerance: 0.02,
  };
  const expectationPath = join(root, "registration.config.json");
  await writeFile(expectationPath, JSON.stringify(expectation));
  await run(["register", root, "--config", expectationPath]);
  await run(["oracle-sanity", root]);
  await run(["lock", root]);

  const state = await loadTaskState(createWorkspaceResolver(root).layout.internal.state);
  expect(state.activePhase).toBe("hull");
  return root;
}

describe("authorship mode defaults and compatibility", () => {
  test("new 3D-oracle workspaces default to derived; projects without an oracle stay independent", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-authorship-"));
    const withOracle = join(parent, "oracle");
    await mkdir(join(withOracle, "refs", "oracle"), { recursive: true });
    await writeFile(join(withOracle, "refs", "oracle", "a.glb"), denseHullFixture().bytes);
    const oracleProject = await initializeWorkspace(withOracle, { id: "a", goal: "g", profile: "tank" });
    expect(oracleProject.project.authorshipMode).toBe("derived");
    const oracleState = await loadTaskState(createWorkspaceResolver(withOracle).layout.internal.state);
    expect(oracleState.authorshipMode).toBe("derived");

    const withoutOracle = join(parent, "plain");
    const plainProject = await initializeWorkspace(withoutOracle, { id: "b", goal: "g", profile: "generic" });
    expect(plainProject.project.authorshipMode).toBe("independent");

    // Explicit clean-room choice overrides the oracle-present default.
    const cleanRoom = join(parent, "clean");
    await mkdir(join(cleanRoom, "refs", "oracle"), { recursive: true });
    await writeFile(join(cleanRoom, "refs", "oracle", "a.glb"), denseHullFixture().bytes);
    const explicit = await initializeWorkspace(cleanRoom, { id: "c", goal: "g", profile: "tank", authorshipMode: "independent" });
    expect(explicit.project.authorshipMode).toBe("independent");
  });

  test("legacy states missing authorshipMode behave as independent and refuse derive", async () => {
    const legacy = JSON.parse(JSON.stringify(createTaskState({ taskId: "legacy", profile: "generic", style: "low-poly-faithful" }))) as Record<string, unknown>;
    delete legacy.authorshipMode;
    delete legacy.derivedBindings;
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-legacy-"));
    const statePath = join(directory, "state.json");
    await writeFile(statePath, JSON.stringify(legacy));
    const loaded = await loadTaskState(statePath);
    expect(loaded.authorshipMode).toBe("independent");
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-legacy-ws-"));
    const root = join(parent, "workspace");
    await initializeWorkspace(root, { id: "l", goal: "g", profile: "generic" });
    const stateFile = createWorkspaceResolver(root).layout.internal.state;
    const workspaceState = await loadTaskState(stateFile);
    delete (workspaceState as unknown as Record<string, unknown>).authorshipMode;
    await saveTaskState(stateFile, workspaceState);
    const reloaded = await loadTaskState(stateFile);
    expect(reloaded.authorshipMode).toBe("independent");
    await expect(derivePhaseSeed(root)).rejects.toThrow(/requires authorshipMode/iu);
  });
});

describe("run B opaque topology regression", () => {
  test("hand-authored opaque hex payloads fail the audit; verified generated modules pass; tampered and stale fail closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-opaque-"));
    const modulePath = join(directory, "model.mjs");
    const hexPayload = Array.from({ length: 1200 }, (_, index) => ((index * 37) % 255).toString(16).padStart(2, "0")).join("");
    await writeFile(modulePath, `import * as THREE from "three";
const HULL_HEX = "${hexPayload}";
export function createCandidate() {
  const bytes = new Uint8Array(HULL_HEX.length / 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < bytes.length; index += 1) view.setUint8(index, parseInt(HULL_HEX.slice(index * 2, index * 2 + 2), 16));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(bytes.buffer), 3));
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}
`);
    const untrusted = await auditCandidateModule(modulePath);
    expect(untrusted.passed).toBe(false);
    expect(untrusted.findings.map((finding) => finding.code)).toContain("opaque-topology-payload");

    const internal = join(directory, ".mesh2threejs", "derived");
    await mkdir(internal, { recursive: true });
    const manifest = {
      schemaVersion: 1,
      kind: "mesh2threejs-derived-seed",
      phase: "hull",
      oraclePreparationIdentity: "identity-a",
      preparedOracleHash: "a".repeat(64),
      operator: "mesh-simplify",
      recipe: { tier: "balanced" },
      inputGeometryHash: "b".repeat(64),
      outputGeometryHash: "c".repeat(64),
      generatedModulePath: modulePath.replaceAll("\\", "/"),
      generatedModuleHash: (await import("node:crypto")).createHash("sha256").update(await readFile(modulePath)).digest("hex"),
      inputTriangles: 100,
      outputTriangles: 10,
    };
    await writeFile(join(internal, "hull.json"), `${JSON.stringify(manifest)}\n`);

    const trusted = await loadTrustedGeneratedModules(internal, directory, "identity-a");
    expect(trusted.size).toBe(1);
    const trustedAudit = await auditCandidateModule(modulePath, { trustedGeneratedModules: trusted });
    expect(trustedAudit.passed).toBe(true);
    expect(trustedAudit.trustedGeneratedModules).toHaveLength(1);

    // Tampered bytes no longer match the manifest hash: the loader drops it, the audit fails.
    await writeFile(modulePath, `${await readFile(modulePath, "utf8")}\n// tampered\n`);
    expect((await loadTrustedGeneratedModules(internal, directory, "identity-a")).size).toBe(0);
    expect((await auditCandidateModule(modulePath, { trustedGeneratedModules: await loadTrustedGeneratedModules(internal, directory, "identity-a") })).passed).toBe(false);

    // A manifest bound to a previous preparation identity never authorizes anything.
    expect((await loadTrustedGeneratedModules(internal, directory, "identity-b")).size).toBe(0);
  });
});

describe("hull contiguity anti-stitch regression", () => {
  function snapshotOf(parts: Array<{ id: string; geometry: THREE.BufferGeometry; position: [number, number, number] }>): ReturnType<typeof snapshotScene> {
    const root = new THREE.Group();
    root.name = "contiguity-fixture";
    for (const part of parts) root.add(semanticMesh(part.id, part.geometry.toNonIndexed(), part.position));
    return snapshotScene(root);
  }
  const mainHull = () => new THREE.BoxGeometry(3, 1, 6);
  const fender = () => new THREE.BoxGeometry(0.4, 0.12, 2.4);
  const stitch = () => new THREE.BoxGeometry(0.8, 0.06, 0.06);

  test("preserving disconnected oracle pieces passes; hidden stitches earn nothing; unrelated floaters fail", () => {
    const oracle = snapshotOf([
      { id: "hull", geometry: mainHull(), position: [0, 1, 0] },
      { id: "hull-fender-l", geometry: fender(), position: [-1.8, 1.15, 0.5] },
    ]);

    // Candidate A: the same two logical pieces.
    const candidateA = snapshotOf([
      { id: "hull", geometry: mainHull(), position: [0, 1, 0] },
      { id: "hull-fender-l", geometry: fender(), position: [-1.8, 1.15, 0.5] },
    ]);
    const rowA = evaluateTankProfile(oracle, candidateA, { certification: "oracle-relative" }).rows.find((row) => row.code === "hull.contiguity");
    expect(rowA?.passed).toBe(true);

    // Candidate B: A plus a hidden long stitch merging them — same verdict, no benefit.
    const candidateB = snapshotOf([
      { id: "hull", geometry: mainHull(), position: [0, 1, 0] },
      { id: "hull-fender-l", geometry: fender(), position: [-1.8, 1.15, 0.5] },
      { id: "hull-stitch", geometry: stitch(), position: [-1.45, 1.07, 0.5] },
    ]);
    const rowB = evaluateTankProfile(oracle, candidateB, { certification: "oracle-relative" }).rows.find((row) => row.code === "hull.contiguity");
    expect(rowB?.passed).toBe(true);
    expect(rowB?.score).toBe(rowA?.score);

    // Candidate C: main hull plus an unrelated floater with no oracle counterpart.
    const candidateC = snapshotOf([
      { id: "hull", geometry: mainHull(), position: [0, 1, 0] },
      { id: "hull-pod", geometry: new THREE.BoxGeometry(0.8, 0.5, 0.8), position: [4, 3, -2] },
    ]);
    const rowC = evaluateTankProfile(oracle, candidateC, { certification: "oracle-relative" }).rows.find((row) => row.code === "hull.contiguity");
    expect(rowC?.passed).toBe(false);

    // Splitting the dominant shell into two significant pieces also fails.
    const candidateD = snapshotOf([
      { id: "hull-front", geometry: new THREE.BoxGeometry(3, 1, 3), position: [0, 1, -1.55] },
      { id: "hull-rear", geometry: new THREE.BoxGeometry(3, 1, 3), position: [0, 1, 1.55] },
    ]);
    const rowD = evaluateTankProfile(oracle, candidateD, { certification: "oracle-relative" }).rows.find((row) => row.code === "hull.contiguity");
    expect(rowD?.passed).toBe(false);
  });
});

describe("phase semantic scope regression", () => {
  function marker(id: string, position: [number, number, number]): THREE.Group {
    const group = new THREE.Group();
    group.name = id;
    group.userData.semanticId = id;
    group.position.set(...position);
    return group;
  }

  test("hull-phase candidates reject future-phase placeholders; turret phase admits locked hull plus turret", () => {
    const hullOnly = new THREE.Group();
    hullOnly.add(semanticMesh("hull", new THREE.BoxGeometry(3, 1, 6), [0, 1, 0]));
    expect(() => assertPhaseSemanticScope("tank", "hull", hullOnly)).not.toThrow();

    const placeholder = new THREE.Group();
    placeholder.add(semanticMesh("hull", new THREE.BoxGeometry(3, 1, 6), [0, 1, 0]));
    placeholder.add(marker("turret-pivot", [0, 1.6, 0]));
    placeholder.add(semanticMesh("turret", new THREE.BoxGeometry(1, 0.5, 1), [0, 1.8, 0]));
    expect(() => assertPhaseSemanticScope("tank", "hull", placeholder)).toThrow(/phase-scope violation/iu);

    const turretPhase = new THREE.Group();
    turretPhase.add(semanticMesh("hull", new THREE.BoxGeometry(3, 1, 6), [0, 1, 0]));
    turretPhase.add(marker("turret-pivot", [0, 1.6, 0]));
    turretPhase.add(semanticMesh("turret", new THREE.BoxGeometry(1, 0.5, 1), [0, 1.8, 0]));
    expect(() => assertPhaseSemanticScope("tank", "turret", turretPhase)).not.toThrow();
  });
});

describe("scale authority registration regression", () => {
  function registeredRoot(lengthZ: number): THREE.Group {
    const root = new THREE.Group();
    root.name = "registered";
    root.userData.forwardAxis = "+z";
    root.userData.upAxis = "+y";
    const hull = semanticMesh("hull", new THREE.BoxGeometry(2, 1, lengthZ).toNonIndexed(), [0, 0.5, 0]);
    root.add(hull);
    root.updateMatrixWorld(true);
    return root;
  }
  const expectation = { forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, requiredSemantics: [], requiredPivots: [], tolerance: 0.02 };

  test("registration verifies the preferred anchor deterministically and rejects a competing scale basis", () => {
    const authority = { mode: "dimension-anchor" as const, id: "hull-structural-length", target: 6.1, unit: "m" as const, source: "refs/docs/geometry-spec.md", locator: "preferred uniform scale anchor" };
    const preferred = verifyOracleRegistration(registeredRoot(6.1), expectation, { scaleAuthority: authority });
    const row = preferred.rows.find((item) => item.code === "registration.scale-authority");
    expect(row?.passed).toBe(true);
    expect(preferred.passed).toBe(true);

    // The plausible secondary datum (overall length incl. fittings) must not silently win.
    const secondary = verifyOracleRegistration(registeredRoot(5.5), expectation, { scaleAuthority: authority });
    const failedRow = secondary.rows.find((item) => item.code === "registration.scale-authority");
    expect(failedRow?.passed).toBe(false);
    expect(secondary.passed).toBe(false);
  });

  test("an anchor without a matching registered semantic fails closed as manual-map-required", () => {
    const evidence = verifyOracleRegistration(registeredRoot(6.1), expectation, { scaleAuthority: { mode: "dimension-anchor", id: "barrel-length", target: 3.2, unit: "m" } });
    const row = evidence.rows.find((item) => item.code === "registration.scale-authority");
    expect(row?.passed).toBe(false);
    expect(String(row?.actual)).toMatch(/manual-map-required/iu);
  });

  test("oracle-units mode adds no additional row", () => {
    const evidence = verifyOracleRegistration(registeredRoot(6.1), expectation, { scaleAuthority: { mode: "oracle-units" } });
    expect(evidence.rows.some((row) => row.code === "registration.scale-authority")).toBe(false);
  });
});

describe("derived seed end-to-end", () => {
  test("derive converts a synthetic dense hull into a low-poly passing seed without hand-authored coordinates", { timeout: 240_000 }, async () => {
    const root = await createDerivedWorkspace();

    // The active phase is hull and the scaffold model carries no geometry yet.
    const result = await derivePhaseSeed(root, {});
    expect(result.status).toBe("seed-passing");
    expect(result.operator).toBe("mesh-simplify");
    expect(result.selected).toBeDefined();
    const manifest = JSON.parse(await readFile(resolve(root, ".mesh2threejs", "derived", "hull.json"), "utf8")) as { inputTriangles: number; outputTriangles: number; generatedModuleHash: string };
    expect(manifest.outputTriangles).toBeLessThan(manifest.inputTriangles * 0.1);
    expect(await exists(resolve(root, "model", ".generated", "hull.mjs"))).toBe(true);
    expect(await readFile(resolve(root, "model", "model.mjs"), "utf8")).toMatch(/\.generated\/hull\.mjs/u);

    const state = await loadTaskState(createWorkspaceResolver(root).layout.internal.state);
    expect(Object.keys(state.derivedBindings)).toContain("model/.generated/hull.mjs");

    // Runtime independence: the wired candidate graph references no oracle path.
    const modelSource = await readFile(resolve(root, "model", "model.mjs"), "utf8");
    expect(modelSource).not.toMatch(/oracle|\.glb/u);

    // Real workspace gate over the wired candidate passes the full hull phase.
    const stdout: string[] = [];
    const stderr: string[] = [];
    const gateExit = await runCli(["gate", root], { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) });
    expect(stderr.join("\n")).toBe("");
    expect(gateExit).toBe(0);
    const gateReport = JSON.parse(stdout.at(-1)!) as { passed: boolean; deterministic: { passed: boolean } };
    expect(gateReport.passed).toBe(true);

    // Quick diagnostic render creates only the small builder set and records no evidence.
    const capturesDirectory = join(root, ".mesh2threejs", "captures");
    const fullRenderRunsBefore = (await exists(capturesDirectory)) ? (await readdir(capturesDirectory)).filter((name) => name.startsWith("render-")).length : 0;
    const evidenceBefore = Object.keys((await loadTaskState(createWorkspaceResolver(root).layout.internal.state)).evidence).length;
    const quickStdout: string[] = [];
    expect(await runCli(["render", root, "--phase", "active", "--quick"], { stdout: (value) => quickStdout.push(value), stderr: () => {} })).toBe(0);
    const quick = JSON.parse(quickStdout.at(-1)!) as { status: string; directory: string };
    expect(quick.status).toBe("quick-diagnostic-captured");
    const quickFiles = await readdir(resolve(root, quick.directory));
    expect(quickFiles.length).toBe(10); // 3 views × (oracle+ candidate + comparison) + quick-manifest
    expect(quickFiles.filter((name) => name.includes("comparison"))).toHaveLength(3);
    const fullRenderRunsAfter = (await readdir(capturesDirectory)).filter((name) => name.startsWith("render-")).length;
    expect(fullRenderRunsAfter).toBe(fullRenderRunsBefore);
    expect(Object.keys((await loadTaskState(createWorkspaceResolver(root).layout.internal.state)).evidence).length).toBe(evidenceBefore);

    // Run A anti-thrash: three equivalent failed gates auto-populate attempts and route to diagnose.
    await writeFile(resolve(root, "model", "model.mjs"), `import * as THREE from "three";\nexport function createCandidate() {\n  return new THREE.Group();\n}\n`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failing: string[] = [];
      expect(await runCli(["gate", root], { stdout: () => {}, stderr: (value) => failing.push(value) })).toBe(4);
    }
    const stalled = await loadTaskState(createWorkspaceResolver(root).layout.internal.state);
    expect(stalled.attempts.length).toBeGreaterThanOrEqual(3);
    expect(stalled.route).toBe("diagnose");
    expect(determineNextAction(stalled).route).toBe("diagnose");

    await rm(resolve(root, ".."), { recursive: true, force: true });
  });
});

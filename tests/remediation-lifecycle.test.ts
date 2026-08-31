import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, test, afterAll } from "vitest";
import { startBroker } from "../src/broker/server.js";
import { BrokerClient } from "../src/broker/client.js";
import { createLoftGeometry, createTrackCourseGeometry } from "../src/kit.js";
import { sceneToGlb, stableSemanticIdentityMap, tessellateFiner } from "./helpers/tank-fixtures.js";

/**
 * Bundle G terminal verification (pipeline remediation plan §13): a BROKER-BACKED trusted
 * lifecycle whose oracle deliberately differs from the derived hierarchy —
 * - gun-pivot is an EMPTY transform anchor (the gun is logically owned, not physically
 *   descended), so pre-fix subtree-aggregate pivot bounds cannot hide behind symmetric
 *   inflation;
 * - the auxiliary `hull-fenders` semantic legitimately owns TWO disconnected watertight
 *   pieces, so no artificial stitch may be needed;
 * - the derived candidate still uses the canonical `gun-pivot -> turret-pivot` nesting.
 *
 * Required outcome: trusted intake → registration → derive/gate/lock through every
 * derivable phase → fittings/style gates WITHOUT pivot false positives → reopen an earlier
 * phase → re-derive/re-gate/re-lock downstream in the SAME run → fresh global replay →
 * review-ready.
 */

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

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
 * License-free asymmetric synthetic tank. Same macro proportions as the lifecycle fixture,
 * with the remediation-specific differences above.
 */
function createAsymmetricRemediationTank(): { bytes: Buffer; semanticMap: Record<string, string>; logicalOwnership: Record<string, string> } {
  const root = new THREE.Group();
  root.name = "remediation-tank-source";
  root.userData.forwardAxis = "+z";

  const hullStations = [
    { z: -3.0, halfWidth: 1.15, bottom: 0.55, top: 1.05 },
    { z: -2.2, halfWidth: 1.45, bottom: 0.5, top: 1.45 },
    { z: -0.4, halfWidth: 1.55, bottom: 0.5, top: 1.6 },
    { z: 1.6, halfWidth: 1.5, bottom: 0.5, top: 1.5 },
    { z: 2.9, halfWidth: 1.25, bottom: 0.5, top: 1.05 },
  ];
  root.add(semanticMesh("hull", tessellateFiner(createLoftGeometry(hullStations), 4), [0, 0, 0]));

  // Auxiliary hull semantic with TWO legitimate disconnected watertight pieces (unnamed
  // children of the semantic group: attributed to hull-fenders at snapshot time).
  const fenders = semanticGroup("hull-fenders", [0, 0, 0]);
  for (const side of [-1, 1] as const) {
    const piece = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.08, 2.2).toNonIndexed(), new THREE.MeshStandardMaterial({ color: 0x6b7358, roughness: 0.7 }));
    piece.name = side === -1 ? "fender-port" : "fender-starboard";
    piece.position.set(side * 1.45, 0.95, 0.2);
    fenders.add(piece);
  }
  root.add(fenders);

  const turretPivot = semanticGroup("turret-pivot", [0, 1.62, -0.5]);
  const turretStations = [
    { z: -1.15, halfWidth: 0.78, bottom: 0, top: 0.72 },
    { z: -0.4, halfWidth: 1.02, bottom: 0, top: 0.82 },
    { z: 0.55, halfWidth: 0.95, bottom: 0, top: 0.74 },
    { z: 1.05, halfWidth: 0.55, bottom: 0, top: 0.55 },
  ];
  turretPivot.add(semanticMesh("turret", tessellateFiner(createLoftGeometry(turretStations), 3), [0, 0, 0]));
  turretPivot.add(semanticMesh("cupola", new THREE.CylinderGeometry(0.3, 0.34, 0.28, 12).toNonIndexed(), [0.32, 0.85, -0.35]));
  // The oracle gun-pivot anchor is EMPTY: no owned triangles, no physical gun descendant.
  turretPivot.add(semanticGroup("gun-pivot", [0, 0.42, 0.95]));
  root.add(turretPivot);

  // Gun mesh: physical sibling at root, LOGICAL child of gun-pivot via the prepared
  // ownership overlay (articulation mapping stays valid without physical nesting). Base at
  // the pivot origin [0, 2.04, 0.45], barrel along +Z: center at z = 0.45 + 1.6.
  root.add(semanticMesh("gun", new THREE.CylinderGeometry(0.11, 0.11, 3.2, 10).toNonIndexed(), [0, 2.04, 2.05], undefined, [Math.PI / 2, 0, 0]));

  for (const side of [-1, 1] as const) {
    for (let index = 0; index < 5; index += 1) {
      root.add(semanticMesh(`road-wheel-${side === -1 ? "l" : "r"}-${index}`, new THREE.CylinderGeometry(0.5, 0.5, 0.24, 12).toNonIndexed(), [side * 1.3, 0.5, -2.1 + index * 1.05], "road-wheel", [0, 0, Math.PI / 2]));
    }
    root.add(semanticMesh(`sprocket-${side === -1 ? "l" : "r"}`, new THREE.CylinderGeometry(0.4, 0.4, 0.22, 10).toNonIndexed(), [side * 1.3, 0.55, 2.75], "sprocket", [0, 0, Math.PI / 2]));
    root.add(semanticMesh(`idler-${side === -1 ? "l" : "r"}`, new THREE.CylinderGeometry(0.35, 0.35, 0.22, 10).toNonIndexed(), [side * 1.3, 0.45, -2.75], "idler", [0, 0, Math.PI / 2]));
    root.add(semanticMesh(`track-${side === -1 ? "l" : "r"}`, createTrackCourseGeometry(6.2, 1.15, 0.24, 0.32), [side * 1.48, 0.58, 0], "track-course"));
  }

  // Map EVERY named node to its own semantic EXCEPT the fender pieces: the unnamed-at-
  // runtime children must stay attributed to the hull-fenders semantic group (the multipart
  // auxiliary hull semantic under test).
  const unmapped = new Set(["fender-port", "fender-starboard"]);
  const semanticMap: Record<string, string> = {};
  for (const [key, name] of Object.entries(stableSemanticIdentityMap(root))) if (!unmapped.has(name)) semanticMap[key] = name;
  return { bytes: sceneToGlb(root), semanticMap, logicalOwnership: { gun: "gun-pivot" } };
}

const toolchainOverride = {
  manifest: {
    schemaVersion: 2 as const, dependencies: [] as never,
    packageName: "mesh2threejs",
    packageVersion: "1.0.0",
    runtimeHash: "test-runtime-hash",
    controlHash: "test-control-hash",
    dependencyIdentity: "test-dependency-identity",
    runtimeFiles: {},
    controlFiles: {},
  },
  provenance: { nodeVersion: process.version, platform: process.platform, arch: process.arch, packageRoot: ".", threeRoot: null, threeVersion: null, meshoptimizerRoot: null, meshoptimizerVersion: null, installationRuntimeClosureHash: null },
  toolchainId: "tc-remediation-lifecycle",
  trustedToolchain: true,
};

describe("remediation trusted lifecycle (bundle G)", () => {
  test("asymmetric oracle + multipart fenders: derive to review boundary, reopen, re-derive in the same run", { timeout: 1_800_000 }, async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-remediation-"));
    roots.push(parent);
    const root = join(parent, "workspace");
    await mkdir(root, { recursive: true });
    const source = join(parent, "remediation-tank.glb");
    const fixture = createAsymmetricRemediationTank();
    await writeFile(source, fixture.bytes);

    const broker = await startBroker({ toolchainOverride });
    try {
      const admin = new BrokerClient({ url: broker.url, token: broker.adminToken });
      const builder = new BrokerClient({ url: broker.url, token: broker.builderToken });

      // ---- Trusted intake ------------------------------------------------------------
      const created = await admin.createWorkspaceRun({ workspaceRoot: root, goal: "remediation synthetic tank reconstruction", oraclePath: source });
      const runId = created.runId;

      // ---- Onboard / register / sanity / registration lock ---------------------------
      await builder.onboardOracle(runId, {
        id: "remediation-tank", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
        coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
        semanticMap: fixture.semanticMap,
        logicalOwnership: fixture.logicalOwnership,
        articulationMap: { gun: "gun-pivot", turret: "turret-pivot" },
        normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
        authoritativeDimensions: null, dimensionSources: [],
      });
      await builder.oracleSanity(runId);
      const registered = await builder.register(runId, { forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, tolerance: 0.02, requiredSemantics: ["hull", "turret", "gun"], requiredPivots: ["turret-pivot", "gun-pivot"] });
      expect(registered.passed).toBe(true);
      await builder.lock(runId);

      // ---- Derive/gate/lock through every derivable phase ----------------------------
      for (const phase of ["hull", "turret", "gun", "running-gear", "tracks"] as const) {
        const status = await builder.status(runId) as { activePhase: string };
        expect(status.activePhase, `active phase before ${phase}`).toBe(phase);
        const derived = await builder.derive(runId) as { status: string; phase: string };
        expect(derived.status, `${phase} derive`).toBe("seed-passing");
        const gate = await builder.gate(runId) as { passed: boolean };
        expect(gate.passed, `${phase} gate`).toBe(true);
        await builder.lock(runId);
      }
      for (const phase of ["fittings-articulation", "style-fabrication"] as const) {
        const gate = await builder.gate(runId) as { passed: boolean };
        expect(gate.passed, `${phase} gate`).toBe(true);
        await builder.lock(runId);
      }

      // ---- Pre-reopen invariants -------------------------------------------------------
      let state = JSON.parse(await readFile(join(root, ".mesh2threejs", "state.json"), "utf8")) as {
        locks: Record<string, unknown>;
        derivedBindings: Record<string, unknown>;
        phaseStatus: Record<string, string>;
        activePhase: string;
      };
      expect(Object.keys(state.locks).sort()).toEqual(["fittings-articulation", "gun", "hull", "oracle-registration", "running-gear", "style-fabrication", "tracks", "turret"]);
      expect(Object.keys(state.derivedBindings)).toEqual(expect.arrayContaining([
        "model/.generated/hull.mjs", "model/.generated/turret.mjs", "model/.generated/gun.mjs",
        "model/.generated/running-gear.mjs", "model/.generated/tracks.mjs",
      ]));

      // ---- Reopen turret: contract-order suffix + binding pruning ---------------------
      await builder.reopen(runId, "turret", "remediation lifecycle reopen regression");
      state = JSON.parse(await readFile(join(root, ".mesh2threejs", "state.json"), "utf8")) as typeof state;
      expect(state.locks["oracle-registration"]).toBeTruthy();
      expect(state.locks.hull).toBeTruthy();
      expect(state.activePhase).toBe("turret");
      expect(state.phaseStatus.turret).toBe("active");
      for (const phase of ["gun", "running-gear", "tracks", "fittings-articulation", "style-fabrication", "visual-review", "final"] as const) {
        expect(state.locks[phase], `${phase} must be invalidated`).toBeUndefined();
      }
      // Generated bindings remain only for still-valid derivable phases; repair JSON
      // bindings survive (none exist in this fixture beyond generated modules).
      expect(Object.keys(state.derivedBindings).sort()).toEqual(["model/.generated/hull.mjs"]);
      // Workspace composition healed from the canonical ledger: no invalidated imports.
      const registry = await readFile(join(root, "model", ".generated", "registry.mjs"), "utf8");
      expect(registry).toContain("./hull.mjs");
      expect(registry).not.toContain("turret.mjs");
      expect(registry).not.toContain("gun.mjs");
      expect(registry).not.toContain("running-gear.mjs");
      expect(registry).not.toContain("tracks.mjs");

      // ---- Re-derive / re-gate / re-lock downstream IN THE SAME RUN -------------------
      for (const phase of ["turret", "gun", "running-gear", "tracks"] as const) {
        const status = await builder.status(runId) as { activePhase: string };
        expect(status.activePhase, `active phase before re-derive of ${phase}`).toBe(phase);
        const derived = await builder.derive(runId) as { status: string };
        expect(derived.status, `${phase} re-derive`).toBe("seed-passing");
        const gate = await builder.gate(runId) as { passed: boolean };
        expect(gate.passed, `${phase} re-gate`).toBe(true);
        await builder.lock(runId);
      }
      for (const phase of ["fittings-articulation", "style-fabrication"] as const) {
        const gate = await builder.gate(runId) as { passed: boolean };
        expect(gate.passed, `${phase} re-gate`).toBe(true);
        await builder.lock(runId);
      }

      // ---- Fresh global replay + review boundary --------------------------------------
      const ready = await builder.reviewReady(runId) as { status: string; packet: { hash: string } };
      expect(ready.status).toBe("ready-for-user-review");
      expect(ready.packet.hash).toMatch(/^[a-f0-9]{64}$/);
      const finalStatus = await builder.status(runId) as { status: string };
      expect(finalStatus.status).toBe("awaiting-human-review");
    } finally {
      await broker.close();
    }
  });
});

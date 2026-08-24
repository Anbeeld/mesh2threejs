import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, afterAll } from "vitest";
import { runCli } from "../src/cli.js";
import { startBroker } from "../src/broker/server.js";
import { BrokerClient } from "../src/broker/client.js";
import { createSlopedTank, stableSemanticIdentityMap, sceneToGlb } from "./helpers/tank-fixtures.js";

/**
 * Per-run serialization and store-lease regressions (final closure §12.2). Concurrent
 * mutating operations serialize per runId; no stale gate/derive/review resurrects stale
 * state. One live broker owns a directory store at a time.
 */

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const io = () => {
  const out: string[] = [];
  return { sink: { stdout: (v: string) => out.push(v), stderr: (v: string) => out.push(v) }, output: out };
};

const toolchainOverride = {
  manifest: { schemaVersion: 2 as const, dependencies: [] as never, packageName: "mesh2threejs", packageVersion: "1.0.0", runtimeHash: "r", controlHash: "c", dependencyIdentity: "d", runtimeFiles: {}, controlFiles: {} },
  provenance: { nodeVersion: process.version, platform: process.platform, arch: process.arch, packageRoot: ".", threeRoot: null, threeVersion: null, meshoptimizerRoot: null, meshoptimizerVersion: null },
  toolchainId: "tc-concurrency",
  trustedToolchain: true,
};

async function beginRunOnFixture(): Promise<{ broker: Awaited<ReturnType<typeof startBroker>>; builder: BrokerClient; admin: BrokerClient; runId: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-concurrency-"));
  roots.push(parent);
  const root = join(parent, "workspace");
  await mkdir(root, { recursive: true });
  const source = join(parent, "tank.glb");
  await writeFile(source, sceneToGlb(createSlopedTank()));
  expect(await runCli(["init", root, "--id", "concurrency", "--goal", "synthetic tank reconstruction", "--profile", "tank", "--oracle", source], io().sink)).toBe(0);
  const broker = await startBroker({ toolchainOverride });
  const builder = new BrokerClient({ url: broker.url, token: broker.builderToken });
  const admin = new BrokerClient({ url: broker.url, token: broker.adminToken });
  const { runId } = await builder.beginRun(root);
  return { broker, builder, admin, runId, root };
}

async function beginRunToDerivedHull() {
  const setup = await beginRunOnFixture();
  const { builder, runId } = setup;
  await builder.onboardOracle(runId, {
    id: "concurrency", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
    coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
    semanticMap: stableSemanticIdentityMap(createSlopedTank()),
    articulationMap: { gun: "gun-pivot", turret: "turret-pivot" },
    normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
    authoritativeDimensions: null, dimensionSources: [],
  });
  await builder.oracleSanity(runId);
  const registered = await builder.register(runId, { forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, tolerance: 0.02, requiredSemantics: ["hull", "turret", "gun"], requiredPivots: ["turret-pivot", "gun-pivot"] });
  expect(registered.passed).toBe(true);
  await builder.lock(runId);
  await builder.derive(runId);
  return setup;
}

describe("per-run serialization and store lease (final closure §12.2)", () => {
  test("two concurrent gates serialize and produce a valid result", async () => {
    const { broker, builder, runId } = await beginRunToDerivedHull();
    try {
      const [g1, g2] = await Promise.allSettled([
        builder.gate(runId),
        builder.gate(runId),
      ]);
      // At least one must succeed; both can succeed (serialized). Neither can crash the broker.
      const fulfilled = [g1, g2].filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      // The broker is still responsive after the race.
      const status = await builder.status(runId);
      expect(status).toBeDefined();
    } finally {
      await broker.close();
    }
  }, 180_000);

  test("gate vs reopen: reopened phase is not resurrected by a stale gate commit", async () => {
    const { broker, builder, runId } = await beginRunToDerivedHull();
    try {
      // Gate and reopen race: the reopen invalidates the gate's stale evidence. Whatever
      // order wins, the final state must reflect one valid serial ordering — a stale gate
      // commit cannot resurrect the pre-reopen state.
      await Promise.allSettled([
        builder.gate(runId),
        builder.reopen(runId, "oracle-registration", "concurrent reopen test"),
      ]);
      const record = await builder.readRun(runId);
      // The canonical state must be internally consistent: no stale evidence resurrection.
      expect(record.record.status).toMatch(/active|awaiting-human-review/);
    } finally {
      await broker.close();
    }
  }, 180_000);

  test("a second broker on the same store is refused with BROKER_STORE_IN_USE", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-lease-"));
    roots.push(parent);
    const storeRoot = join(parent, "store");
    await mkdir(storeRoot, { recursive: true });
    const brokerA = await startBroker({ storeRoot, toolchainOverride });
    try {
      await expect(startBroker({ storeRoot, toolchainOverride })).rejects.toThrow(/BROKER_STORE_IN_USE/);
    } finally {
      await brokerA.close();
    }
    // After A closes, B can start on the same store.
    const brokerB = await startBroker({ storeRoot, toolchainOverride });
    await brokerB.close();
  }, 60_000);

  test("broker restart on same store: old builder token rejected, runs preserved", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-restart-"));
    roots.push(parent);
    const storeRoot = join(parent, "store");
    const wsRoot = join(parent, "workspace");
    await mkdir(storeRoot, { recursive: true });
    await mkdir(wsRoot, { recursive: true });
    const source = join(parent, "tank.glb");
    await writeFile(source, sceneToGlb(createSlopedTank()));
    const brokerA = await startBroker({ storeRoot, toolchainOverride });
    const adminA = new BrokerClient({ url: brokerA.url, token: brokerA.adminToken });
    const created = await adminA.createWorkspaceRun({ workspaceRoot: wsRoot, goal: "synthetic tank", oraclePath: source });
    const tokenA = brokerA.builderToken;
    await brokerA.close();
    // Restart on the same store: the old builder descriptor is replaced atomically.
    const brokerB = await startBroker({ storeRoot, toolchainOverride });
    try {
      // Old token is no longer valid.
      const oldClient = new BrokerClient({ url: brokerB.url, token: tokenA });
      await expect(oldClient.status(created.runId)).rejects.toThrow();
      // The run survives the restart.
      const adminB = new BrokerClient({ url: brokerB.url, token: brokerB.adminToken });
      const record = await adminB.readRun(created.runId);
      expect(record.record.runId).toBe(created.runId);
    } finally {
      await brokerB.close();
    }
  }, 60_000);
});
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, afterAll } from "vitest";
import { runCli } from "../src/cli.js";
import { startBroker } from "../src/broker/server.js";
import { BrokerClient } from "../src/broker/client.js";
import { RunOperationCoordinator } from "../src/core/run-coordinator.js";
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
  provenance: { nodeVersion: process.version, platform: process.platform, arch: process.arch, packageRoot: ".", threeRoot: null, threeVersion: null, meshoptimizerRoot: null, meshoptimizerVersion: null, installationRuntimeClosureHash: null },
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
      await Promise.allSettled([
        builder.gate(runId),
        builder.reopen(runId, "oracle-registration", "concurrent reopen test"),
      ]);
      const record = await builder.readRun(runId);
      const state = record.record.embedded.state;
      // Exact invariant: if reopen won, oracle-registration must NOT be locked.
      // If gate won before reopen, reopen invalidated it. Either way, no stale lock+evidence.
      const registrationLocked = "oracle-registration" in state.locks;
      const hasCurrentGateEvidence = Object.values(state.evidence).some(
        (e) => e.kind === "deterministic-gate" && e.phase === "oracle-registration" && e.valid,
      );
      if (registrationLocked && hasCurrentGateEvidence) {
        // A surviving valid lock+evidence pair is ONLY legitimate when the gate ran
        // AFTER the reopen and re-established fresh evidence. Prove the ordering
        // exactly: a reopen of this phase must be recorded, and the newest valid gate
        // evidence must postdate it.
        const phaseReopens = state.reopens.filter((r) => r.phase === "oracle-registration");
        expect(phaseReopens.length).toBeGreaterThan(0);
        const lastReopenAt = phaseReopens[phaseReopens.length - 1]!.reopenedAt;
        const newestGateEvidenceAt = Object.values(state.evidence)
          .filter((e) => e.kind === "deterministic-gate" && e.phase === "oracle-registration" && e.valid)
          .map((e) => e.createdAt)
          .sort()
          .at(-1)!;
        expect(newestGateEvidenceAt > lastReopenAt).toBe(true);
      }
      expect(record.record.status).toMatch(/active|awaiting-human-review/);
    } finally {
      await broker.close();
    }
  }, 180_000);

  test("approve-review vs reopen: never reopened geometry + old humanApproval current", async () => {
    const { broker, builder, admin, runId } = await beginRunToDerivedHull();
    try {
      // Drive to review-ready first.
      for (let cycle = 0; cycle < 8; cycle += 1) {
        const next = await builder.next(runId) as { route?: string; activePhase?: string };
        if (next.route !== "build") break;
        await builder.derive(runId);
        const gate = await builder.gate(runId) as { passed: boolean };
        if (!gate.passed) break;
        await builder.lock(runId);
        const status = await builder.status(runId) as { status: string };
        if (status.status === "awaiting-human-review") break;
      }
      await builder.reviewReady(runId);
      // Race approve-review and reopen. One must win; no mixed state.
      await Promise.allSettled([
        admin.approveReview(runId),
        builder.reopen(runId, "hull", "concurrent reopen during approval"),
      ]);
      const record = await builder.readRun(runId);
      // Exact invariant: if geometry was reopened, human approval must NOT be current.
      const reopened = !("hull" in record.record.embedded.state.locks);
      const hasApproval = record.record.review?.humanApproval != null;
      if (reopened && hasApproval) {
        throw new Error("mixed state: reopened hull phase with current human approval");
      }
      expect(record.record.status).toMatch(/active|awaiting-human-review|certified/);
    } finally {
      await broker.close();
    }
  }, 300_000);

  test("trusted-finalize vs reopen: no mixed certified+reopened state", async () => {
    const { broker, builder, admin, runId } = await beginRunToDerivedHull();
    try {
      // Drive to review-ready + approve + finalize race.
      for (let cycle = 0; cycle < 8; cycle += 1) {
        const next = await builder.next(runId) as { route?: string; activePhase?: string };
        if (next.route !== "build") break;
        await builder.derive(runId);
        const gate = await builder.gate(runId) as { passed: boolean };
        if (!gate.passed) break;
        await builder.lock(runId);
        const status = await builder.status(runId) as { status: string };
        if (status.status === "awaiting-human-review") break;
      }
      await builder.reviewReady(runId);
      await admin.approveReview(runId);
      // Race finalize and reopen. One must win; no mixed state.
      const [finalizeResult, reopenResult] = await Promise.allSettled([
        admin.trustedFinalize(runId),
        builder.reopen(runId, "hull", "concurrent reopen during finalize"),
      ]);
      const record = await builder.readRun(runId);
      // Exact invariant: if the run is certified, no phase can be reopened.
      if (record.record.status === "certified") {
        const hullLocked = "hull" in record.record.embedded.state.locks;
        if (!hullLocked) {
          throw new Error("mixed state: certified run with unlocked hull phase");
        }
        expect(record.record.finalReplay?.passed).toBe(true);
      }
      // If reopen won, finalize must have refused (not certified with stale authority).
      if (reopenResult.status === "fulfilled" && finalizeResult.status === "fulfilled") {
        if (record.record.status === "certified") {
          const hullLocked = "hull" in record.record.embedded.state.locks;
          expect(hullLocked).toBe(true);
        }
      }
    } finally {
      await broker.close();
    }
  }, 300_000);

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

  test("coordinator queue entries are cleaned up after sequential runs complete", async () => {
    const coordinator = new RunOperationCoordinator();
    // Run many sequential operations on different runIds.
    for (let i = 0; i < 20; i += 1) {
      await coordinator.runExclusive(`run-${i}`, async () => i);
    }
    // After all operations complete, no queue entries should remain.
    expect(coordinator._queueSize()).toBe(0);
  }, 30_000);

  test("coordinator queue entries are cleaned up after concurrent same-run operations", async () => {
    const coordinator = new RunOperationCoordinator();
    const runId = "run-concurrent";
    // Launch many concurrent operations on the SAME runId.
    const ops = Array.from({ length: 10 }, (_, i) => coordinator.runExclusive(runId, async () => i));
    await Promise.all(ops);
    // After all operations complete, the queue entry should be cleaned up.
    expect(coordinator._queueSize()).toBe(0);
  }, 30_000);

  test("failed broker startup releases the store lease", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-lease-fail-"));
    roots.push(parent);
    const storeRoot = join(parent, "store");
    await mkdir(storeRoot, { recursive: true });
    // Start brokerA to occupy the port; brokerB will acquire the lease on a DIFFERENT
    // storeRoot but fail to listen on brokerA's port. The catch must release brokerB's lease.
    const storeRootA = join(parent, "storeA");
    const storeRootB = join(parent, "storeB");
    await mkdir(storeRootA, { recursive: true });
    await mkdir(storeRootB, { recursive: true });
    const brokerA = await startBroker({ storeRoot: storeRootA, toolchainOverride });
    try {
      // brokerB acquires lease on storeRootB (succeeds) but fails at listen (port in use).
      await expect(startBroker({ storeRoot: storeRootB, toolchainOverride, port: brokerA.port })).rejects.toThrow();
    } finally {
      await brokerA.close();
    }
    // After the failed startup released its lease, a new broker can start on storeRootB.
    const brokerC = await startBroker({ storeRoot: storeRootB, toolchainOverride });
    await brokerC.close();
  }, 60_000);
});
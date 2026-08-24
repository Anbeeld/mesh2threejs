import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, afterAll } from "vitest";
import { runCli } from "../src/cli.js";
import { startBroker } from "../src/broker/server.js";
import { BrokerClient } from "../src/broker/client.js";
import { createSlopedTank, stableSemanticIdentityMap, sceneToGlb } from "./helpers/tank-fixtures.js";

/**
 * REAL trusted broker lifecycle (closure plan §12.I1). Everything after workspace
 * initialization flows through the trusted operation API — no manually marked phases,
 * no injected execution authority, no fabricated replay records, no caller-supplied
 * packet hashes, no canonical-state mutation. The builder token drives geometry work;
 * the admin token only delivers final human approval and finalize.
 */

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const io = () => {
  const out: string[] = [];
  return { sink: { stdout: (v: string) => out.push(v), stderr: (v: string) => out.push(v) }, output: out };
};

/** Verified toolchain fixture standing in for a shipped-manifest installation (§10.G2). */
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
  toolchainId: "tc-lifecycle-fixed",
  trustedToolchain: true,
};

describe("trusted broker reconstruction lifecycle (I1)", () => {
  test("safe-default begin-run through derive/gate/lock to human-approved certification", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-broker-lifecycle-"));
    roots.push(parent);
    const root = join(parent, "workspace");
    await mkdir(root, { recursive: true });
    const source = join(parent, "tank.glb");
    await writeFile(source, sceneToGlb(createSlopedTank()));
    // Workspace scaffolding happens on the development surface; every TRUSTED act below
    // goes through the broker. The trusted intake creates the workspace itself.

    const broker = await startBroker({ toolchainOverride });
    roots.push(broker.url);
    try {
      const builder = new BrokerClient({ url: broker.url, token: broker.builderToken });
      const admin = new BrokerClient({ url: broker.url, token: broker.adminToken });

      // ---- Trusted intake: admin creates the workspace+run pinned to the oracle ---
      const created = await admin.createWorkspaceRun({ workspaceRoot: root, goal: "synthetic tank reconstruction", oraclePath: source });
      const runId = created.runId;
      expect(runId).toMatch(/^run-/);
      // A second begin on the same workspace is refused (already bound).
      await expect(builder.beginRun(root)).rejects.toThrow(/already bound/i);

      // ---- Onboard + register + sanity + registration lock ----------------------------
      await builder.onboardOracle(runId, {
        id: "broker-lifecycle", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
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

      // ---- Derive/gate/lock per builder phase -----------------------------------------
      for (let cycle = 0; cycle < 8; cycle += 1) {
        const next = await builder.next(runId) as { route?: string; activePhase?: string };
        if (next.route === "diagnose") break;
        const phase = next.activePhase!;
        const derived = await builder.derive(runId) as { status: string };
        void derived;
        const gate = await builder.gate(runId) as { passed: boolean };
        if (!gate.passed) break;
        await builder.lock(runId);
        const status = await builder.status(runId) as { status: string; phaseStatus: Record<string, string> };
        if (status.status === "awaiting-human-review") break;
        const remaining = Object.entries(status.phaseStatus).filter(([p, s]) => p !== "final" && p !== "visual-review" && s !== "passed" && s !== "skipped");
        if (!remaining.length) break;
      }

      const preReview = await builder.status(runId) as { status: string; phaseStatus: Record<string, string> };
      const unlocked = Object.entries(preReview.phaseStatus).filter(([p, s]) => p !== "final" && p !== "visual-review" && s !== "passed" && s !== "skipped");
      expect(unlocked).toEqual([]);
      expect(preReview.status).toBe("active");

      // ---- Review-ready computes captures + full binding internally --------------------
      const ready = await builder.reviewReady(runId) as { status: string; packet: { hash: string }; capture: { viewerScene: string } };
      expect(ready.status).toBe("ready-for-user-review");
      expect(ready.packet.hash).toMatch(/^[a-f0-9]{64}$/);
      const midStatus = await builder.status(runId) as { status: string };
      expect(midStatus.status).toBe("awaiting-human-review");

      // ---- Builder approval attempts are refused --------------------------------------
      const builderApproval = await fetch(broker.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "approve-review", runId, token: broker.builderToken }) });
      expect(builderApproval.status).toBe(403);
      const builderFinalize = await fetch(broker.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "trusted-finalize", runId, token: broker.builderToken }) });
      expect(builderFinalize.status).toBe(403);

      // ---- Human approval sealed from canonical values; finalize runs a FRESH replay ---
      await admin.approveReview(runId);
      const finalized = await admin.trustedFinalize(runId);
      expect(finalized.status).toBe("certified");

      // Certified runs are immutable and the workspace mirror reflects certification.
      const record = await builder.readRun(runId);
      expect(record.record.status).toBe("certified");
      const mirrorState = JSON.parse(await readFile(join(root, ".mesh2threejs", "state.json"), "utf8")) as { status: string; mirrorOfRun?: { mirrorOfRun: string } };
      expect(mirrorState.status).toBe("certified");
      expect(mirrorState.mirrorOfRun?.mirrorOfRun).toBe(runId);

      // Ask-first boundaries still hold on the bound workspace.
      const viewerResult = io();
      expect(await runCli(["viewer", "start", root], viewerResult.sink)).toBe(2);
      expect(viewerResult.output.join("\n")).toMatch(/approve-viewer-start/);
    } finally {
      await broker.close();
    }
  }, 300_000);
});

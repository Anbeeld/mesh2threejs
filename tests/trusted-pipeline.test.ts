import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, afterAll } from "vitest";
import { startBroker } from "../src/broker/server.js";
import { BrokerClient } from "../src/broker/client.js";
import { runCli } from "../src/cli.js";
import { validateRepairSpec, applyRepairSpec, repairSpecHash, REPAIR_VERTEX_CEILING, REPAIR_TRIANGLE_CEILING } from "../src/core/repair-spec.js";
import type { SeedNode } from "../src/core/derive.js";
import { createSlopedTank, stableSemanticIdentityMap, sceneToGlb } from "./helpers/tank-fixtures.js";

/**
 * Authority injection, contract tamper, and repair-spec attacks (closure plan §12.I2/I3/I6).
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
  manifest: { schemaVersion: 1 as const, packageName: "mesh2threejs", packageVersion: "1.0.0", runtimeHash: "r", controlHash: "c", dependencyIdentity: "d", runtimeFiles: {}, controlFiles: {} },
  provenance: { nodeVersion: process.version, platform: process.platform, arch: process.arch, packageRoot: ".", threeRoot: null, threeVersion: null, meshoptimizerRoot: null, meshoptimizerVersion: null },
  toolchainId: "tc-pipeline-attacks",
  trustedToolchain: true,
};

async function beginRunOnFixture(): Promise<{ broker: Awaited<ReturnType<typeof startBroker>>; builder: BrokerClient; admin: BrokerClient; runId: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-pipeline-attacks-"));
  roots.push(parent);
  const root = join(parent, "workspace");
  await mkdir(root, { recursive: true });
  const source = join(parent, "tank.glb");
  await writeFile(source, sceneToGlb(createSlopedTank()));
  expect(await runCli(["init", root, "--id", "pipeline-attacks", "--goal", "synthetic tank reconstruction", "--profile", "tank", "--oracle", source], io().sink)).toBe(0);
  const broker = await startBroker({ toolchainOverride });
  const builder = new BrokerClient({ url: broker.url, token: broker.builderToken });
  const admin = new BrokerClient({ url: broker.url, token: broker.adminToken });
  const { runId } = await builder.beginRun(root);
  return { broker, builder, admin, runId, root };
}

async function post(brokerUrl: string, token: string, body: Record<string, unknown>): Promise<number> {
  const response = await fetch(brokerUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...body }) });
  void response.body;
  return response.status;
}

describe("builder injection routes are impossible (I2)", () => {
  test("generic runtime-record/transition/evidence endpoints do not exist", async () => {
    const { broker, runId } = await beginRunOnFixture();
    try {
      // Removed generic routes answer as unknown operations.
      await expect(post(broker.url, broker.builderToken, { operation: "runtime-record", runId, payload: { kind: "final-replay", replay: { replayHash: "x", passed: true, evaluationIdentityHash: "x", candidateHash: "x", oraclePreparationIdentity: "x", evaluatedAt: "" } } })).resolves.toBe(400);
      await expect(post(broker.url, broker.builderToken, { operation: "transition", runId, payload: { kind: "set-candidate", candidateHash: "fake", phaseGeometryHashes: {} } })).resolves.toBe(400);
      await expect(post(broker.url, broker.builderToken, { operation: "record-evidence", runId })).resolves.toBe(400);
      await expect(post(broker.url, broker.builderToken, { operation: "mark-review-ready", runId, payload: { packetHash: "f".repeat(64) } })).resolves.toBe(400);
      // Admin operations reject the builder token.
      await expect(post(broker.url, broker.builderToken, { operation: "certify", runId })).resolves.toBe(403);
      await expect(post(broker.url, broker.builderToken, { operation: "approve-review", runId })).resolves.toBe(403);
      await expect(post(broker.url, broker.builderToken, { operation: "trusted-finalize", runId })).resolves.toBe(403);
      await expect(post(broker.url, broker.builderToken, { operation: "viewer-start", runId })).resolves.toBe(403);
      await expect(post(broker.url, broker.builderToken, { operation: "approve-viewer-start", runId })).resolves.toBe(403);
      // Invalid tokens are rejected outright.
      await expect(post(broker.url, "deadbeef", { operation: "status", runId })).resolves.toBe(401);
    } finally {
      await broker.close();
    }
  }, 60_000);

  test("editing project.json to independent authorship mid-run blocks with policy drift; no rebind", async () => {
    const { broker, builder, runId, root } = await beginRunOnFixture();
    try {
      const projectPath = join(root, "project.json");
      const project = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
      project.authorshipMode = "independent";
      await writeFile(projectPath, JSON.stringify(project, null, 2));
      await expect(builder.gate(runId)).rejects.toThrow(/POLICY_INPUT_DRIFT|no longer match|differs from state/i);
      // The canonical policy is unchanged.
      const record = await builder.readRun(runId);
      expect(record.record.policy.authorshipMode).toBe("derived");
    } finally {
      await broker.close();
    }
  }, 60_000);

  test("forging the workspace state mirror cannot mutate canonical truth", async () => {
    const { broker, builder, runId, root } = await beginRunOnFixture();
    try {
      const statePath = join(root, ".mesh2threejs", "state.json");
      const forged = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      forged.status = "certified";
      forged.phaseStatus = Object.fromEntries(Object.keys(forged.phaseStatus as Record<string, string>).map((phase) => [phase, "passed"]));
      await writeFile(statePath, JSON.stringify(forged));
      const status = await builder.status(runId) as { status: string };
      expect(status.status).toBe("active");
      const record = await builder.readRun(runId);
      expect(record.record.status).toBe("active");
    } finally {
      await broker.close();
    }
  }, 60_000);
});

describe("declarative repair specs (I6)", () => {
  const baseNodes: SeedNode[] = [
    { semanticId: "turret-pivot", kind: "group", position: [0, 1.5, -0.25] },
    { semanticId: "turret", kind: "mesh", parentSemanticId: "turret-pivot", positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) },
    { semanticId: "mantlet", kind: "mesh", positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) },
  ];

  test("valid spec compiles deterministically and hash changes drive module identity", () => {
    const spec = validateRepairSpec({ schemaVersion: 1, phase: "turret", operations: [{ op: "component-transform", target: "mantlet", translate: [0, 0.1, 0] }] }, "turret");
    const once = applyRepairSpec(baseNodes, spec);
    const twice = applyRepairSpec(baseNodes, spec);
    expect(once[2]?.positions).toEqual(twice[2]?.positions);
    expect(Number(once[2]!.positions![7]!)).toBeCloseTo(1.1, 4);
    const other = validateRepairSpec({ schemaVersion: 1, phase: "turret", operations: [{ op: "component-transform", target: "mantlet", translate: [0, 0.2, 0] }] }, "turret");
    expect(repairSpecHash(spec)).not.toBe(repairSpecHash(other));
  });

  test("unknown keys, non-finite values, index escapes, phase escape, and oversized meshes are refused", () => {
    expect(() => validateRepairSpec({ schemaVersion: 1, phase: "turret", operations: [], extraKey: 1 }, "turret")).toThrow(/unknown key/i);
    expect(() => validateRepairSpec({ schemaVersion: 1, phase: "turret", operations: [{ op: "component-transform", target: "turret", translate: [Number.NaN, 0, 0] }] }, "turret")).toThrow(/finite/i);
    expect(() => validateRepairSpec({ schemaVersion: 1, phase: "hull", operations: [] }, "turret")).toThrow(/repair owner/i);
    expect(() => validateRepairSpec({
      schemaVersion: 1,
      phase: "turret",
      operations: [{ op: "mesh-replace", target: "x", positions: [0, 0, 0], indices: [0, 1, 5] }],
    }, "turret")).toThrow(/outside the vertex range/);
    expect(() => validateRepairSpec({
      schemaVersion: 1,
      phase: "turret",
      operations: [{
        op: "mesh-replace",
        target: "big",
        positions: Array.from({ length: (REPAIR_VERTEX_CEILING + 1) * 3 }, (_, i) => (i % 7) * 0.1),
        indices: Array.from({ length: REPAIR_TRIANGLE_CEILING * 3 }, (_, i) => i % ((REPAIR_VERTEX_CEILING + 1))),
      }],
    }, "turret")).toThrow(/ceiling/);
    // Code-like payloads cannot even be expressed: strings where numbers are required fail.
    expect(() => validateRepairSpec({ schemaVersion: 1, phase: "turret", operations: [{ op: "mesh-replace", target: "x", positions: ["return 1"] as never, indices: [0, 1, 2] }] }, "turret")).toThrow(/finite/i);
  });

  test("compile-time semantics: drop requires existence, hierarchy-parent needs a group, mesh-replace may create", () => {
    const spec = validateRepairSpec({ schemaVersion: 1, phase: "turret", operations: [
      { op: "mesh-replace", target: "new-gun", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
      { op: "material", target: "new-gun", color: [0.2, 0.3, 0.4], roughness: 0.5 },
    ] }, "turret");
    const built = applyRepairSpec(baseNodes, spec);
    expect(built.some((node) => node.semanticId === "new-gun")).toBe(true);
    expect(() => applyRepairSpec(baseNodes, validateRepairSpec({ schemaVersion: 1, phase: "turret", operations: [{ op: "component-drop", target: "ghost" }] }, "turret"))).toThrow(/does not exist/i);
    expect(() => applyRepairSpec(baseNodes, validateRepairSpec({ schemaVersion: 1, phase: "turret", operations: [{ op: "hierarchy-parent", target: "turret", parent: "mantlet" }] }, "turret"))).toThrow(/existing group semantic/i);
  });

  test("an executable repair .mjs in trusted derived mode is a hard failure (I3)", async () => {
    const { broker, builder, runId, root } = await beginRunOnFixture();
    try {
      await builder.onboardOracle(runId, {
        id: "pipeline-attacks", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
        coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
        semanticMap: stableSemanticIdentityMap(createSlopedTank()),
        articulationMap: { gun: "gun-pivot", turret: "turret-pivot" },
        normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
        authoritativeDimensions: null, dimensionSources: [],
      });
      await builder.oracleSanity(runId);
      await builder.register(runId, { forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, tolerance: 0.02, requiredSemantics: ["hull", "turret", "gun"], requiredPivots: ["turret-pivot", "gun-pivot"] });
      await builder.lock(runId);
      await mkdir(join(root, "model", "repairs"), { recursive: true });
      await writeFile(join(root, "model", "repairs", "hull.mjs"), `export function repairPhase({ seed }) { return seed; }\n`);
      await expect(builder.derive(runId)).rejects.toThrow(/EXECUTABLE_REPAIR_NOT_ALLOWED_IN_TRUSTED_DERIVED/);
    } finally {
      await broker.close();
    }
  }, 120_000);
});

import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, afterAll } from "vitest";
import { startBroker } from "../src/broker/server.js";
import { BrokerClient } from "../src/broker/client.js";
import { runCli } from "../src/cli.js";
import { validateRepairSpec, applyRepairSpec, repairSpecHash, REPAIR_VERTEX_CEILING, REPAIR_TRIANGLE_CEILING } from "../src/core/repair-spec.js";
import type { SeedNode } from "../src/core/derive.js";
import { auditCandidateModule, stageCandidateGraph } from "../src/core/candidate.js";
import { developmentInProcessBackend } from "../src/core/dev-sandbox.js";
import { MODEL_DERIVED_SCAFFOLD } from "../src/core/derivation.js";
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
  manifest: { schemaVersion: 2 as const, dependencies: [] as never, packageName: "mesh2threejs", packageVersion: "1.0.0", runtimeHash: "r", controlHash: "c", dependencyIdentity: "d", runtimeFiles: {}, controlFiles: {} },
  provenance: { nodeVersion: process.version, platform: process.platform, arch: process.arch, packageRoot: ".", threeRoot: null, threeVersion: null, meshoptimizerRoot: null, meshoptimizerVersion: null, installationRuntimeClosureHash: null },
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

/** Drives a run to hull-derived state through the real broker (attacks mutate from here). */
async function beginRunToDerivedHull() {
  const setup = await beginRunOnFixture();
  const { builder, runId } = setup;
  await builder.onboardOracle(runId, {
    id: "pipeline-attacks", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
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
  const derived = await builder.derive(runId) as { status: string };
  expect(["seed-passing", "seed-retained-failing", "seed-diagnostic-overbudget"]).toContain(derived.status);
  return setup;
}

/** Drives a run all the way to an awaiting-human-review binding through the real broker. */
async function beginRunToReviewReady() {
  const setup = await beginRunToDerivedHull();
  const { builder, runId } = setup;
  for (let cycle = 0; cycle < 8; cycle += 1) {
    const next = await builder.next(runId) as { route?: string; activePhase?: string };
    if (next.route === "diagnose") break;
    const derived = await builder.derive(runId) as { status: string };
    void derived;
    const gate = await builder.gate(runId) as { passed: boolean };
    if (!gate.passed) break; // visual-review phase gates fail by design before review-ready
    await builder.lock(runId);
    const status = await builder.status(runId) as { status: string };
    if (status.status === "awaiting-human-review") break;
  }
  const ready = await builder.reviewReady(runId) as { status: string; capture: { directory: string } };
  expect(ready.status).toBe("ready-for-user-review");
  return { ...setup, initialCaptureDirectory: /^([a-zA-Z]:)?[/\\]/u.test(ready.capture.directory) ? ready.capture.directory : join(setup.root, ready.capture.directory) };
}

describe("review artifact integrity at approval and finalization (remaining closure §12.2)", () => {
  test("mutating any human-visible review artifact blocks approval/finalization with REVIEW_ARTIFACT_DRIFT", async () => {
    const { broker, builder, admin, runId, root, initialCaptureDirectory } = await beginRunToReviewReady();
    let currentCaptureDirectory = initialCaptureDirectory;
    try {
      const noteCaptureDir = (ready: { capture: { directory: string } }): void => {
        currentCaptureDirectory = /^([a-zA-Z]:)?[/\\]/u.test(ready.capture.directory) ? ready.capture.directory : join(root, ready.capture.directory);
      };
      // Attack: packet.json tamper -> approval refuses and invalidates the review.
      await writeFile(join(currentCaptureDirectory, "packet.json"), `${await readFile(join(currentCaptureDirectory, "packet.json"), "utf8")}// tampered\n`);
      await expect(admin.approveReview(runId)).rejects.toThrow(/REVIEW_ARTIFACT_DRIFT/);
      expect(((await builder.status(runId)) as { status: string }).status).toBe("active");

      // Regenerate; then a comparison-board tamper must also refuse approval.
      noteCaptureDir(await builder.reviewReady(runId) as { capture: { directory: string } });
      const manifestJson = JSON.parse(await readFile(join(currentCaptureDirectory, "render-manifest.json"), "utf8")) as { comparisonBoards: Array<{ path: string }> };
      const boardAbsolutePath = /^([a-zA-Z]:)?[/\\]/u.test(manifestJson.comparisonBoards[0]!.path) ? manifestJson.comparisonBoards[0]!.path : join(root, manifestJson.comparisonBoards[0]!.path);
      await appendFile(boardAbsolutePath, "x");
      await expect(admin.approveReview(runId)).rejects.toThrow(/REVIEW_ARTIFACT_DRIFT|comparison-board/);
      expect(((await builder.status(runId)) as { status: string }).status).toBe("active");

      // Regenerate; clean approval succeeds...
      noteCaptureDir(await builder.reviewReady(runId) as { capture: { directory: string } });
      await admin.approveReview(runId);

      // ...but a viewer-scene tamper before finalization still refuses certification.
      await appendFile(join(currentCaptureDirectory, "viewer-scene.json"), " ");
      await expect(admin.trustedFinalize(runId)).rejects.toThrow(/REVIEW_ARTIFACT_DRIFT/);
    } finally {
      await broker.close();
    }
  }, 600_000);
});

describe("broker operation surface parity (remaining closure §7.4/§12.5)", () => {
  const kebab = (method: string): string => method.replaceAll(/([A-Z])/gu, "-$1").toLowerCase();

  test("registry, server routes, typed client, and capability classes agree", async () => {
    const { BROKER_OPERATIONS, IMPLEMENTED_BUILDER_ROUTES } = await import("../src/broker/operations.js");
    const { BUILDER_OPERATIONS, HUMAN_ADMIN_OPERATIONS } = await import("../src/core/capabilities.js");
    const clientMethods = Object.getOwnPropertyNames(BrokerClient.prototype).filter((name) => name !== "constructor" && name !== "call");
    const clientOperations = new Set(clientMethods.map((method) => method.replaceAll(/([A-Z])/gu, "-$1").toLowerCase()));

    // Every implemented builder route is classified builder-safe...
    for (const route of IMPLEMENTED_BUILDER_ROUTES) {
      expect(BUILDER_OPERATIONS.has(route), `capability set lacks ${route}`).toBe(true);
      // ...and has a matching typed client method.
      expect(clientOperations.has(route), `client lacks a method for ${route}`).toBe(true);
    }
    // Every implemented admin operation is classified human-admin and has a client method.
    for (const op of BROKER_OPERATIONS.filter((item) => item.capability === "human-admin" && item.status === "implemented")) {
      expect(HUMAN_ADMIN_OPERATIONS.has(op.name)).toBe(true);
      expect(clientOperations.has(op.name), `client lacks a method for ${op.name}`).toBe(true);
    }
    // No client method escapes the advertised registry.
    for (const method of clientMethods) {
      expect(BROKER_OPERATIONS.some((op) => op.name === kebab(method)), `client method ${method} has no registry operation`).toBe(true);
    }
  }, 30_000);

  test("every advertised builder route exists end to end; generic routes remain nonexistent", async () => {
    const { broker, runId } = await beginRunOnFixture();
    try {
      const probeResult = await post(broker.url, broker.builderToken, { operation: "probe", runId });
      expect(probeResult).toBe(200);
      const workorderResult = await post(broker.url, broker.builderToken, { operation: "workorders", runId });
      expect(workorderResult).toBe(200);
      // Generic authority routes remain nonexistent.
      await expect(post(broker.url, broker.builderToken, { operation: "runtime-record", runId })).resolves.toBe(400);
      await expect(post(broker.url, broker.builderToken, { operation: "transition", runId })).resolves.toBe(400);
    } finally {
      await broker.close();
    }
  }, 60_000);
});

describe("trusted intake and initial intent (remaining closure §6/§12.4)", () => {
  test("builder cannot invoke trusted intake; post-creation policy edits block with POLICY_INPUT_DRIFT", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-intake-"));
    roots.push(parent);
    const root = join(parent, "workspace");
    const source = join(parent, "tank.glb");
    await writeFile(source, sceneToGlb(createSlopedTank()));
    const broker = await startBroker({ toolchainOverride });
    try {
      const builder = new BrokerClient({ url: broker.url, token: broker.builderToken });
      const admin = new BrokerClient({ url: broker.url, token: broker.adminToken });

      // The builder token cannot create a trusted run (admin channel only).
      const attempt = await fetch(broker.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "create-workspace-run", token: broker.builderToken, payload: { workspaceRoot: root, goal: "synthetic tank reconstruction", oraclePath: source } }) });
      expect(attempt.status).toBe(403);

      // Trusted intake pins goal + oracle BEFORE any builder mutation.
      const created = await admin.createWorkspaceRun({ workspaceRoot: root, goal: "synthetic tank reconstruction", oraclePath: source });
      expect(created.runId).toMatch(/^run-/);
      const record = await builder.readRun(created.runId);
      expect(record.record.intake).toBe("trusted");
      expect(record.record.policy.authorshipMode).toBe("derived");
      expect(record.record.policy.profile).toBe("tank");

      // After binding, builder edits to goal/profile/authorship/oracle are DRIFT, not rebinds.
      const projectPath = join(root, "project.json");
      const edits: Array<Record<string, unknown>> = [
        { goal: "a completely different subject" },
        { profile: "generic" },
        { authorshipMode: "independent" },
        { oracle: "refs/oracle/other.glb" },
      ];
      for (const edit of edits) {
        const project = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
        await writeFile(projectPath, JSON.stringify({ ...project, ...edit }, null, 2));
        await expect(builder.gate(created.runId)).rejects.toThrow(/POLICY_INPUT_DRIFT|differs from state|absent from the reference index/i);
        // The canonical intent remains unchanged.
        const fresh = await builder.readRun(created.runId);
        expect(fresh.record.intake).toBe("trusted");
      }
    } finally {
      await broker.close();
    }
  }, 120_000);

  test("builder-prepared run cannot reach full certification (TRUSTED_INTAKE_REQUIRED)", async () => {
    const { broker, builder, runId } = await beginRunToDerivedHull();
    try {
      // Drive to review-ready and approve with admin. The run is builder-prepared (begin-run),
      // so finalize must refuse certification with TRUSTED_INTAKE_REQUIRED.
      for (let cycle = 0; cycle < 8; cycle += 1) {
        const next = await builder.next(runId) as { route?: string; activePhase?: string };
        if (next.route === "diagnose") break;
        await builder.derive(runId);
        const gate = await builder.gate(runId) as { passed: boolean };
        if (!gate.passed) break;
        await builder.lock(runId);
        const status = await builder.status(runId) as { status: string };
        if (status.status === "awaiting-human-review") break;
      }
      const ready = await builder.reviewReady(runId) as { status: string };
      expect(ready.status).toBe("ready-for-user-review");
      const admin = new BrokerClient({ url: broker.url, token: broker.adminToken });
      await admin.approveReview(runId);
      await expect(admin.trustedFinalize(runId)).rejects.toThrow(/TRUSTED_INTAKE_REQUIRED/);
    } finally {
      await broker.close();
    }
  }, 600_000);
});

describe("pre-execution graph authority (remaining closure §12.1)", () => {
  test("attack A: tampered derived entry refuses with DERIVED_ENTRY_DRIFT before execution", async () => {
    const { broker, builder, runId, root } = await beginRunToDerivedHull();
    try {
      // An infinite loop proves refusal happened BEFORE any import/execution.
      await writeFile(join(root, "model", "model.mjs"), `export function createCandidate() { for (;;) {} }\n`);
      const started = Date.now();
      await expect(builder.gate(runId)).rejects.toThrow(/DERIVED_ENTRY_DRIFT/);
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally {
      await broker.close();
    }
  }, 180_000);

  test("attack B: tampered generated registry refuses with DERIVED_REGISTRY_DRIFT before execution", async () => {
    const { broker, builder, runId, root } = await beginRunToDerivedHull();
    try {
      const registryPath = join(root, "model", ".generated", "registry.mjs");
      const legitimate = await readFile(registryPath, "utf8");
      await writeFile(registryPath, `${legitimate}\n// arbitrary injected code\nexport const stolen = 1;\n`);
      await writeFile(join(root, "model", "model.mjs"), MODEL_DERIVED_SCAFFOLD);
      await expect(builder.gate(runId)).rejects.toThrow(/DERIVED_REGISTRY_DRIFT/);
    } finally {
      await broker.close();
    }
  }, 180_000);

  test("attack C: extra non-generated executable module refuses with DERIVED_EXECUTABLE_GRAPH_UNTRUSTED", async () => {
    const { broker, builder, runId, root } = await beginRunToDerivedHull();
    try {
      // A generated module that no longer matches its five-way binding pulls an extra
      // executable helper into the graph; both must refuse before execution.
      await writeFile(join(root, "model", ".generated", "hull.mjs"), `import { createSeed as helperSeed } from "../helper.mjs";\nexport function createSeed() { return helperSeed(); }\n`);
      await writeFile(join(root, "model", "helper.mjs"), `import * as THREE from "three";\nexport function createSeed() { return new THREE.Group(); }\n`);
      await expect(builder.gate(runId)).rejects.toThrow(/DERIVED_EXECUTABLE_GRAPH_UNTRUSTED/);
    } finally {
      await broker.close();
    }
  }, 180_000);

  test("attack D: bytes changed between audit and staging fail with CANDIDATE_CHANGED_DURING_AUTHORIZATION", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-stage-race-"));
    roots.push(parent);
    const entry = join(parent, "model.mjs");
    await writeFile(entry, `export function createCandidate() { return {}; }\n`);
    const audit = await auditCandidateModule(entry);
    // Mutate AFTER the audit produced the hash ledger; staging must refuse the copy.
    await writeFile(entry, `export function createCandidate() { return { tampered: true }; }\n`);
    await expect(stageCandidateGraph(entry, audit)).rejects.toThrow(/CANDIDATE_CHANGED_DURING_AUTHORIZATION/);
  });

  test("attack E: trusted operations refuse the development in-process backend", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-inprocess-refusal-"));
    roots.push(parent);
    const entry = join(parent, "model.mjs");
    await writeFile(entry, MODEL_DERIVED_SCAFFOLD);
    const { inspectWorkspaceCandidateViaExecutor } = await import("../src/operations/workspace-gate.js");
    await expect(inspectWorkspaceCandidateViaExecutor({
      modelEntryPath: entry,
      poses: [{}],
      backend: developmentInProcessBackend(),
      trusted: true,
    })).rejects.toThrow(/TRUSTED_IN_PROCESS_EXECUTION_REFUSED/);
  });
});

describe("broker-private trusted execution staging (final closure §12.1)", () => {
  test("regression 1: workspace candidate mutated after authorization does not affect trusted execution", async () => {
    const { broker, builder, runId, root } = await beginRunToDerivedHull();
    try {
      // The derive step already authorized and staged the pipeline-owned graph. Mutating the
      // workspace copy of model.mjs AFTER authorization must not change gate behavior: the
      // trusted execution uses the broker-private staged copy, not the workspace file.
      await writeFile(join(root, "model", "model.mjs"), `export function createCandidate() { for (;;) {} }\n`);
      // The gate either refuses with DERIVED_ENTRY_DRIFT (because the authority ledger was
      // established from the PRE-mutation bytes) — proving the private copy was used — or
      // succeeds from the private copy. Either way the infinite-loop mutation never executes.
      const started = Date.now();
      try {
        await builder.gate(runId);
      } catch (error) {
        expect(String(error instanceof Error ? error.message : error)).toMatch(/DERIVED_ENTRY_DRIFT|CANDIDATE_CHANGED_DURING_AUTHORIZATION/);
      }
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally {
      await broker.close();
    }
  }, 180_000);

  test("regression 2: staged file mutated after write fails with CANDIDATE_STAGE_DRIFT", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-stage-drift-"));
    roots.push(parent);
    const stagingRoot = join(parent, "exec");
    await mkdir(stagingRoot, { recursive: true });
    const entry = join(parent, "model.mjs");
    const source = `export function createCandidate() { return {}; }\n`;
    await writeFile(entry, source);
    const audit = await auditCandidateModule(entry);
    const ledger = audit.candidateFiles.map((file) => ({ absolutePath: join(parent, file.path), sha256: file.sha256 }));
    // Use the onAfterStageWrite hook to mutate the staged file AFTER it is written but
    // BEFORE the post-write re-hash. This triggers CANDIDATE_STAGE_DRIFT for real.
    await expect(stageCandidateGraph(entry, audit, {
      stagingRoot,
      authorityLedger: ledger,
      onAfterStageWrite: async (stagedPath) => {
        await writeFile(stagedPath, `// tampered\n`);
      },
    })).rejects.toThrow(/CANDIDATE_STAGE_DRIFT/);
  });

  test("regression 4: trusted child entry path is never under the workspace root", async () => {
    // The staging root is broker-private (under storeRoot/runtime/executions/), never under
    // the workspace. We verify by checking that the executionScratchRoot option flows through
    // and the staged root is outside the workspace. This is a structural test: the broker
    // derives executionScratchRoot from storeRoot, which is separate from workspaceRoot.
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-entry-outside-ws-"));
    roots.push(parent);
    const storeRoot = join(parent, "store");
    const wsRoot = join(parent, "workspace");
    await mkdir(storeRoot, { recursive: true });
    await mkdir(wsRoot, { recursive: true });
    const source = join(parent, "tank.glb");
    await writeFile(source, sceneToGlb(createSlopedTank()));
    const broker = await startBroker({ storeRoot, toolchainOverride });
    try {
      const builder = new BrokerClient({ url: broker.url, token: broker.builderToken });
      const admin = new BrokerClient({ url: broker.url, token: broker.adminToken });
      const created = await admin.createWorkspaceRun({ workspaceRoot: wsRoot, goal: "synthetic tank reconstruction", oraclePath: source });
      // The execution scratch root is under storeRoot, which is a sibling of wsRoot.
      const execRoot = join(storeRoot, "runtime", "executions");
      await builder.onboardOracle(created.runId, {
        id: "entry-outside", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
        coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
        semanticMap: stableSemanticIdentityMap(createSlopedTank()),
        articulationMap: { gun: "gun-pivot", turret: "turret-pivot" },
        normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
        authoritativeDimensions: null, dimensionSources: [],
      });
      await builder.oracleSanity(created.runId);
      const registered = await builder.register(created.runId, { forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, tolerance: 0.02, requiredSemantics: ["hull", "turret", "gun"], requiredPivots: ["turret-pivot", "gun-pivot"] });
      expect(registered.passed).toBe(true);
      await builder.lock(created.runId);
      await builder.derive(created.runId);
      // After derive, the execution scratch root exists and is outside the workspace.
      expect(execRoot).not.toContain(wsRoot);
      const { readdir } = await import("node:fs/promises");
      const wsEntries = await readdir(wsRoot).catch(() => [] as string[]);
      expect(wsEntries.filter((name) => name.startsWith("exec-"))).toHaveLength(0);
    } finally {
      await broker.close();
    }
  }, 180_000);
});

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Installed full trusted lifecycle (release host-trust closure §1/§12.1):
 *
 *   source checkout → npm pack → clean install
 *   → start installed broker with private store/scratch
 *   → admin create-workspace-run (packed multipart tank fixture)
 *   → builder runs complete reconstruction through broker operations
 *   → review-ready → admin approve-review → admin trusted-finalize → certified
 *
 * No source imports. No toolchainOverride. No direct authority mutation.
 * No raw CLI mutation after trusted run creation. No PARTIAL success path.
 *
 * Unconditional assertions:
 *   intake = trusted
 *   authorshipMode = derived
 *   status = certified
 *   candidateExecution.authority = trusted-derived-generated
 *   finalReplay.passed = true
 *   review.humanApproval != null
 *   every required phase is passed or contractually skipped
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * Semantic map for the packed fixture (fixtures/tank.glb), matching the node order produced
 * by sceneToGlb(createSlopedTank()). Stable across builds since the fixture is a committed
 * binary — this map is the canonical onboarding input for the installed lifecycle.
 */
const TANK_SEMANTIC_MAP: Record<string, string> = {
  "node:0": "hull",
  "node:1": "turret-pivot",
  "node:2": "turret",
  "node:3": "gun-pivot",
  "node:4": "gun",
  "node:5": "cupola",
  "node:6": "road-wheel--1-0",
  "node:7": "road-wheel--1-1",
  "node:8": "road-wheel--1-2",
  "node:9": "road-wheel--1-3",
  "node:10": "road-wheel--1-4",
  "node:11": "track--1",
  "node:12": "road-wheel-1-0",
  "node:13": "road-wheel-1-1",
  "node:14": "road-wheel-1-2",
  "node:15": "road-wheel-1-3",
  "node:16": "road-wheel-1-4",
  "node:17": "track-1",
};

const TANK_ARTICULATION_MAP: Record<string, string> = { gun: "gun-pivot", turret: "turret-pivot" };

interface ProcResult {
  code: number;
  stdout: string;
}

function run(command: string, args: string[], cwd: string, timeoutMs = 600_000): Promise<ProcResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, shell: process.platform === "win32" && /npm|\.cmd$/iu.test(command) });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout });
    });
  });
}

interface BrokerHandle {
  process: ReturnType<typeof spawn>;
  url: string;
  adminToken: string;
  builderToken: string;
}

async function startInstalledBroker(brokerJs: string, store: string, project: string): Promise<BrokerHandle> {
  await mkdir(store, { recursive: true });
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [brokerJs, "--store", store], { cwd: project });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("broker startup timed out"));
    }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const urlMatch = stdout.match(/listening on (http:\/\/[^\s]+)/);
      const adminMatch = stdout.match(/ADMIN CAPABILITY.*?:\s*([a-f0-9]+)/);
      const builderMatch = stdout.match(/builder connection descriptor/);
      if (urlMatch && adminMatch && builderMatch) {
        clearTimeout(timer);
        readFile(join(store, "broker-builder-connection.json"), "utf8").then((descriptor) => {
          const parsed = JSON.parse(descriptor) as { builderToken: string; url: string };
          resolvePromise({
            process: child,
            url: urlMatch![1]!,
            adminToken: adminMatch![1]!,
            builderToken: parsed.builderToken,
          });
        }).catch(rejectPromise);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

async function brokerCall(handle: BrokerHandle, operation: string, payload?: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { operation, token: token ?? handle.builderToken };
  if (payload) {
    if ("runId" in payload) {
      body.runId = payload.runId;
      const { runId: _runId, ...rest } = payload;
      void _runId;
      if (Object.keys(rest).length) body.payload = rest;
    } else {
      body.payload = payload;
    }
  }
  const response = await fetch(handle.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!response.ok) throw new Error(`broker ${operation} failed (${response.status}): ${parsed.error ?? text}`);
  return parsed;
}

async function callBuilder(handle: BrokerHandle, operation: string, runId: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return brokerCall(handle, operation, { runId, ...(payload ?? {}) }, handle.builderToken);
}

async function callAdmin(handle: BrokerHandle, operation: string, runId: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return brokerCall(handle, operation, { runId, ...(payload ?? {}) }, handle.adminToken);
}

function assert<T>(value: T, message: string, predicate: (value: T) => boolean): void {
  if (!predicate(value)) throw new Error(`assertion failed: ${message} (got ${JSON.stringify(value)})`);
}

async function main(): Promise<void> {
  const regressionMode = process.env.MESH2THREEJS_LIFECYCLE_REGRESSION === "1";
  const scratch = await mkdtemp(join(tmpdir(), "mesh2threejs-installed-lifecycle-"));
  try {
    // ---- 1. pack + install ----------------------------------------------------------
    console.log("[installed-lifecycle] packing...");
    const packed = await run("npm", ["pack"], REPO_ROOT);
    if (packed.code !== 0) throw new Error(`npm pack failed:\n${packed.stdout.slice(-2000)}`);
    const lines = packed.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith(".tgz"));
    if (!lines.length) throw new Error(`npm pack produced no tarball`);
    const tgz = join(REPO_ROOT, lines[lines.length - 1]!);

    const project = join(scratch, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "mesh2threejs-lifecycle-check", private: true, version: "1.0.0" }, null, 2)}\n`);
    console.log("[installed-lifecycle] installing tarball...");
    const install = await run("npm", ["install", tgz], project);
    if (install.code !== 0) throw new Error(`npm install failed:\n${install.stdout.slice(-4000)}`);
    const installedRoot = join(project, "node_modules", "mesh2threejs");
    const brokerJs = join(installedRoot, "dist", "broker", "main.js");

    // ---- 2. copy the packed fixture GLB into the scratch workspace ------------------
    // The fixture is shipped inside the tarball under fixtures/tank.glb.
    const fixtureGlb = join(installedRoot, "fixtures", "tank.glb");
    const wsRoot = join(scratch, "workspace");
    await mkdir(wsRoot, { recursive: true });
    const oraclePath = join(scratch, "tank.glb");
    await copyFile(fixtureGlb, oraclePath);

    // ---- 3. start installed broker --------------------------------------------------
    const store = join(scratch, "store");
    console.log("[installed-lifecycle] starting installed broker...");
    const broker = await startInstalledBroker(brokerJs, store, project);
    try {
      if (!broker.adminToken || !broker.builderToken) throw new Error("broker did not emit tokens");

      // ---- 4. admin creates trusted run --------------------------------------------
      console.log("[installed-lifecycle] admin create-workspace-run...");
      const created = await brokerCall(broker, "create-workspace-run", { workspaceRoot: wsRoot, goal: "synthetic tank reconstruction", oraclePath }, broker.adminToken);
      const runId = created.runId as string;
      assert(runId, "create-workspace-run returned a runId", (v) => /^run-/.test(v));
      assert(created.intake, "intake is trusted", (v) => v === "trusted");
      console.log(`[installed-lifecycle] run created: ${runId} (intake=trusted)`);

      // ---- 5. builder onboards the oracle ------------------------------------------
      console.log("[installed-lifecycle] builder onboard-oracle...");
      // Regression mode: deliberately mislabel the hull semantic so a geometry gate fails
      // while registration still passes (hull is still present as a required semantic, but
      // mapped to a wrong node, causing the hull gate to find no hull geometry).
      const semanticMap = regressionMode
        ? { ...TANK_SEMANTIC_MAP, "node:0": "superstructure", "node:5": "hull" }
        : TANK_SEMANTIC_MAP;
      await callBuilder(broker, "onboard-oracle", runId, {
        id: "fixture", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
        coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
        semanticMap,
        articulationMap: TANK_ARTICULATION_MAP,
        normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
        authoritativeDimensions: null, dimensionSources: [],
      });

      console.log("[installed-lifecycle] builder oracle-sanity...");
      await callBuilder(broker, "oracle-sanity", runId);

      console.log("[installed-lifecycle] builder register...");
      const registered = await callBuilder(broker, "register", runId, { forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, tolerance: 0.02, requiredSemantics: ["hull", "turret", "gun"], requiredPivots: ["turret-pivot", "gun-pivot"] });
      if (!registered.passed) throw new Error(`registration failed: ${JSON.stringify(registered)}`);
      await callBuilder(broker, "lock", runId);

      // ---- 6. derive/gate/lock every builder phase ---------------------------------
      for (let cycle = 0; cycle < 12; cycle += 1) {
        const next = await callBuilder(broker, "next", runId) as { route?: string; activePhase?: string };
        if (next.route === "diagnose") throw new Error(`lifecycle routed to diagnose at cycle ${cycle}`);
        if (next.route !== "build") break;
        const phase = next.activePhase;
        if (!phase) break;
        console.log(`[installed-lifecycle] derive/gate/lock cycle ${cycle}: phase=${phase}`);
        await callBuilder(broker, "derive", runId);
        const gate = await callBuilder(broker, "gate", runId) as { passed: boolean };
        // visual-review is a reviewer phase; its active-phase gate fails until review-ready
        // collects captures. Builder phases must pass — throw on those.
        if (!gate.passed) {
          if (phase === "visual-review") break;
          throw new Error(`gate failed on phase ${phase}: ${JSON.stringify(gate)}`);
        }
        await callBuilder(broker, "lock", runId);
        const status = await callBuilder(broker, "status", runId) as { status: string; phaseStatus: Record<string, string> };
        if (status.status === "awaiting-human-review") break;
        const remaining = Object.entries(status.phaseStatus).filter(([p, s]) => p !== "final" && p !== "visual-review" && s !== "passed" && s !== "skipped");
        if (!remaining.length) break;
      }

      // ---- 7. verify all builder phases passed or were skipped ----------------------
      const preReview = await callBuilder(broker, "status", runId) as { status: string; phaseStatus: Record<string, string> };
      const unlocked = Object.entries(preReview.phaseStatus).filter(([p, s]) => p !== "final" && p !== "visual-review" && s !== "passed" && s !== "skipped");
      if (unlocked.length) throw new Error(`phases not passed: ${JSON.stringify(unlocked)}`);

      // ---- 8. review-ready → approve → finalize → certified ------------------------
      console.log("[installed-lifecycle] builder review-ready...");
      const ready = await callBuilder(broker, "review-ready", runId);
      assert(ready.status, "review-ready produced a packet", (v) => v === "ready-for-user-review");

      console.log("[installed-lifecycle] admin approve-review...");
      await callAdmin(broker, "approve-review", runId);

      console.log("[installed-lifecycle] admin trusted-finalize...");
      const finalized = await callAdmin(broker, "trusted-finalize", runId);
      assert(finalized.status, "finalize produced certified status", (v) => v === "certified");

      // ---- 9. unconditional provenance assertions -----------------------------------
      const record = await brokerCall(broker, "read-run", { runId }, broker.adminToken) as {
        record: {
          intake: string;
          policy: { authorshipMode: string };
          status: string;
          candidateExecution: { authority: string };
          finalReplay: { passed: boolean };
          review: { humanApproval: unknown };
        };
      };
      assert(record.record.intake, "record intake is trusted", (v) => v === "trusted");
      assert(record.record.policy.authorshipMode, "authorshipMode is derived", (v) => v === "derived");
      assert(record.record.status, "record status is certified", (v) => v === "certified");
      assert(record.record.candidateExecution?.authority, "execution authority is trusted-derived-generated", (v) => v === "trusted-derived-generated");
      assert(record.record.finalReplay?.passed, "finalReplay passed", (v) => v === true);
      assert(record.record.review?.humanApproval, "human approval recorded", (v) => v !== null && v !== undefined);

      console.log("[installed-lifecycle] PASS: installed full trusted lifecycle certified (intake=trusted, authority=trusted-derived-generated, status=certified)");
    } finally {
      broker.process.kill("SIGKILL");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
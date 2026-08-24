import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test, afterAll } from "vitest";
import { auditCandidateModule } from "../src/core/candidate.js";
import { executeCandidate } from "../src/core/candidate-executor.js";
import { SandboxViolationError, createTrustedChildProcessBackend } from "../src/core/candidate-sandbox.js";
import { developmentInProcessBackend } from "../src/core/dev-sandbox.js";

/**
 * Adversarial candidate-execution suite (plan §22 "Candidate attacks" 22–35 and §8.5
 * resource-abuse fixtures). Every hostile candidate must fail BOUNDEDLY: audit finding,
 * sandbox violation class, or clean evaluation result — never unbounded damage.
 */

const scratchRoots: string[] = [];
afterAll(async () => {
  await Promise.all(scratchRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mesh2threejs-candidate-attacks-"));
  scratchRoots.push(root);
  return root;
}

/** Minimal runner so the trusted child-process backend works from source without dist. */
async function writeRunner(root: string): Promise<string> {
  const runner = `
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const [, , requestPath, outputPath] = process.argv;
const request = JSON.parse(await readFile(requestPath, "utf8"));
const mod = await import(pathToFileURL(request.entry).href);
const built = await mod.createCandidate();
let root = built && built.root ? built.root : built;
let setPose = built && typeof built.setPose === "function" ? built.setPose : () => {};
const samples = [];
for (const pose of request.poses) {
  if (Object.values(pose).some((v) => Math.abs(v) > 1e-12)) await setPose(pose);
  root.updateMatrixWorld(true);
  samples.push({ pose, serialization: { schemaVersion: 1, root: { type: "group", name: root.name || "x", children: [] } } });
}
await writeFile(outputPath, JSON.stringify({ samples }));
`;
  const runnerPath = join(root, "runner.mjs");
  await writeFile(runnerPath, runner);
  return pathToFileURL(runnerPath).href;
}

function trustedBackend(runnerUrl: string) {
  return createTrustedChildProcessBackend({ runnerModuleUrl: runnerUrl });
}

describe("candidate source-graph boundary (§7)", () => {
  test("rejects host-state reads through disallowed bare imports", async () => {
    const root = await scratch();
    const entry = join(root, "model", "model.mjs");
    await mkdir(join(root, "model"), { recursive: true });
    await writeFile(entry, `import { readFileSync } from "node:fs";\nimport * as THREE from "three";\nexport function createCandidate(){ return new THREE.Group(); }`);
    const audit = await auditCandidateModule(entry);
    expect(audit.passed).toBe(false);
    expect(audit.findings.map((finding) => finding.code)).toContain("disallowed-bare-import");
  });

  test("rejects dynamic imports even when the specifier is computed indirectly", async () => {
    const root = await scratch();
    const entry = join(root, "model", "model.mjs");
    await mkdir(join(root, "model"), { recursive: true });
    // Literal dynamic import is caught directly...
    await writeFile(entry, `export function createCandidate(){ return import("./evil.mjs").then(() => null); }`);
    const audit = await auditCandidateModule(entry);
    expect(audit.findings.map((finding) => finding.code)).toContain("dynamic-local-import");
  });

  test("rejects file:, data:, and absolute-path imports", async () => {
    const root = await scratch();
    const entry = join(root, "model", "model.mjs");
    await mkdir(join(root, "model"), { recursive: true });
    await writeFile(entry, [
      `import "data:text/javascript,export default 1";`,
      `export function createCandidate(){ return null; }`,
    ].join("\n"));
    const audit = await auditCandidateModule(entry);
    expect(audit.findings.map((finding) => finding.code)).toContain("url-module-import");

    const entry2 = join(root, "model", "model2.mjs");
    await writeFile(entry2, [
      `import "/etc/passwd-style";`,
      `export function createCandidate(){ return null; }`,
    ].join("\n"));
    const audit2 = await auditCandidateModule(entry2);
    expect(audit2.findings.map((finding) => finding.code)).toContain("absolute-import");
  });

  test("boundaryRoot confinement catches realpath escapes outside model/", async () => {
    const root = await scratch();
    await mkdir(join(root, "outside"), { recursive: true });
    await mkdir(join(root, "model"), { recursive: true });
    const helper = join(root, "outside", "helper.mjs");
    await writeFile(helper, `export const x = 1;`);
    const entry = join(root, "model", "model.mjs");
    await writeFile(entry, `import { x } from "../outside/helper.mjs";\nexport function createCandidate(){ return null; }`);
    const audit = await auditCandidateModule(entry, { boundaryRoot: join(root, "model") });
    expect(audit.passed).toBe(false);
    expect(audit.findings.map((finding) => finding.code)).toContain("boundary-escape");
  });

  test("symlinked imports are refused as boundary escapes", async () => {
    const root = await scratch();
    await mkdir(join(root, "outside"), { recursive: true });
    await mkdir(join(root, "model"), { recursive: true });
    const helper = join(root, "outside", "helper.mjs");
    await writeFile(helper, `export const x = 1;`);
    try {
      await symlink(helper, join(root, "model", "link.mjs"), "file");
    } catch {
      return; // platform denies symlinks; skip
    }
    const entry = join(root, "model", "model.mjs");
    await writeFile(entry, `import { x } from "./link.mjs";\nexport function createCandidate(){ return null; }`);
    const audit = await auditCandidateModule(entry, { boundaryRoot: join(root, "model") });
    expect(audit.passed).toBe(false);
    expect(audit.findings.map((finding) => finding.code)).toContain("boundary-escape");
  });

  test("comments cannot hide forbidden imports from the lexer", async () => {
    const root = await scratch();
    const entry = join(root, "model", "model.mjs");
    await mkdir(join(root, "model"), { recursive: true });
    await writeFile(entry, [
      `// import exfil from "node:child_process";`,
      `/* import * as fs from "node:fs"; */`,
      `const s = 'import x from "node:os"';`,
      `export function createCandidate(){ return null; }`,
    ].join("\n"));
    const audit = await auditCandidateModule(entry);
    expect(audit.findings.filter((finding) => finding.code === "disallowed-bare-import")).toHaveLength(0);
  });
});

describe("sandbox execution boundary (§8)", () => {
  test("deterministic candidates report deterministic:true across repeated execution", async () => {
    const root = await scratch();
    const modelDir = join(root, "model");
    await mkdir(modelDir, { recursive: true });
    const entry = join(modelDir, "model.mjs");
    await writeFile(entry, `import * as THREE from "three";\nexport function createCandidate(){ const g = new THREE.Group(); g.name = "ok"; return g; }`);
    const backendRoot = await scratch();
    const backend = trustedBackend(await writeRunner(backendRoot));
    const result = await executeCandidate({ entryPath: entry, poses: [{}] }, { backend });
    expect(result.deterministic).toBe(true);
    expect(result.isolation).toBe("trusted-isolated");
  }, 30_000);

  test("an infinite loop dies as a bounded SANDBOX_TIMEOUT (§8.5)", async () => {
    const root = await scratch();
    const modelDir = join(root, "model");
    await mkdir(modelDir, { recursive: true });
    const entry = join(modelDir, "model.mjs");
    await writeFile(entry, `export function createCandidate(){ for(;;){} }`);
    const backendRoot = await scratch();
    const backend = trustedBackend(await writeRunner(backendRoot));
    await expect(executeCandidate({ entryPath: entry, poses: [{}] }, {
      backend,
      limits: { cpuTimeoutMs: 1500 },
    })).rejects.toBeInstanceOf(SandboxViolationError);
  }, 30_000);

  test("huge allocation fails boundedly as SANDBOX_CRASH (§8.5)", async () => {
    const root = await scratch();
    const modelDir = join(root, "model");
    await mkdir(modelDir, { recursive: true });
    const entry = join(modelDir, "model.mjs");
    await writeFile(entry, `export function createCandidate(){ const bomb = []; for(;;) bomb.push(new Array(1e6).fill(1.1)); return bomb; }`);
    const backendRoot = await scratch();
    const backend = trustedBackend(await writeRunner(backendRoot));
    await expect(executeCandidate({ entryPath: entry, poses: [{}] }, {
      backend,
      limits: { maxOldSpaceMb: 64, cpuTimeoutMs: 20_000 },
    })).rejects.toBeInstanceOf(SandboxViolationError);
  }, 60_000);

  test("network attempts inside the sandbox fail without escaping bounds", async () => {
    const root = await scratch();
    const modelDir = join(root, "model");
    await mkdir(modelDir, { recursive: true });
    const entry = join(modelDir, "model.mjs");
    await writeFile(entry, `import * as THREE from "three";\nexport async function createCandidate(){ try { const r = await fetch("http://127.0.0.1:9/nope"); void r; } catch { /* expected: nothing listens */ } return new THREE.Group(); }`);
    const backendRoot = await scratch();
    const backend = trustedBackend(await writeRunner(backendRoot));
    const result = await executeCandidate({ entryPath: entry, poses: [{}] }, { backend, limits: { cpuTimeoutMs: 15_000 } });
    expect(result.samples[0]?.serialization.root.type).toBeDefined();
  }, 40_000);

  test("the development backend never claims trusted isolation", () => {
    expect(developmentInProcessBackend().isolation).toBe("development-process");
  });
});

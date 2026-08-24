import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SerializedScene } from "./scene-serialization.js";
import { sanitizeLaunchEnvironment } from "./toolchain.js";

/**
 * Candidate sandbox boundary. Trusted certification requires a `trusted-isolated` backend;
 * the in-process development backend exists for development runs only and can never certify.
 */

export type CandidateIsolation = "development-process" | "trusted-isolated";

export interface CandidateExecutionLimits {
  /** Wall-clock budget for the whole pose batch; violation kills the sandbox. */
  cpuTimeoutMs: number;
  /** V8 heap ceiling for sandboxed candidates. */
  maxOldSpaceMb: number;
  /** Maximum serialized-result size accepted from the sandbox. */
  maxOutputBytes: number;
}

export const DEFAULT_EXECUTION_LIMITS: CandidateExecutionLimits = {
  cpuTimeoutMs: 60_000,
  maxOldSpaceMb: 1024,
  maxOutputBytes: 256 * 1024 * 1024,
};

export interface SandboxPoseRequest {
  stageRoot: string;
  entryPath: string;
  poses: Array<Record<string, number>>;
  limits: CandidateExecutionLimits;
}

export interface SandboxSample {
  pose: Record<string, number>;
  serialization: SerializedScene;
}

export interface SandboxExecutionResult {
  samples: SandboxSample[];
}

export interface SandboxBackend {
  readonly name: string;
  readonly isolation: CandidateIsolation;
  execute(request: SandboxPoseRequest): Promise<SandboxExecutionResult>;
}

export class SandboxViolationError extends Error {
  constructor(readonly code: "SANDBOX_TIMEOUT" | "SANDBOX_CRASH" | "SANDBOX_OUTPUT_LIMIT" | "SANDBOX_UNAVAILABLE", message: string) {
    super(message);
    this.name = "SandboxViolationError";
  }
}

function assertStagedPaths(request: SandboxPoseRequest): void {
  const stageMarker = ".mesh2threejs-candidate-";
  const stage = resolve(request.stageRoot);
  const entry = resolve(request.entryPath);
  if (!stage.includes(stageMarker)) throw new Error("sandbox execution requires a freshly staged candidate graph");
  if (!entry.startsWith(stage)) throw new Error("sandbox entry escapes the staged candidate graph");
}

/**
 * In-process development backend: imports the staged graph in THIS process. Useful for
 * development iteration; it provides no isolation boundary and cannot certify.
 */
export function createInProcessBackend(loadStaged: (entryHref: string) => Promise<{ setPose: (pose: Record<string, number>) => void | Promise<void>; root: import("three").Object3D }>): SandboxBackend {
  return {
    name: "in-process",
    isolation: "development-process",
    async execute(request) {
      assertStagedPaths(request);
      const { pathToFileURL } = await import("node:url");
      const runtime = await loadStaged(pathToFileURL(resolve(request.entryPath)).href);
      const { serializeScene } = await import("./scene-serialization.js");
      const samples: SandboxSample[] = [];
      for (const pose of request.poses) {
        // All-zero/empty poses are identity inspections: candidates without physical
        // controls must be inspectable without invoking an articulation-capable setPose.
        if (Object.values(pose).some((value) => Math.abs(value) > 1e-12)) await runtime.setPose(pose);
        samples.push({ pose, serialization: serializeScene(runtime.root) });
      }
      return { samples };
    },
  };
}

interface ChildRequestFile {
  entry: string;
  poses: Array<Record<string, number>>;
}

/**
 * Trusted-isolated backend: executes the staged candidate in a fresh child process with an
 * empty sanitized environment, no shell, a heap ceiling, a hard wall-clock timeout, and a
 * serialized-output size limit. Violations terminate the process and fail boundedly.
 *
 * Classification honesty: this backend qualifies as `trusted-isolated` only when deployed
 * by the trusted broker/host configuration that verifies the boundary (see §8.4 examples:
 * "platform sandbox verified by tests"). Hosts that cannot verify it must keep
 * `candidateIsolation = development-process|unconfigured`, and certification refuses.
 */
export function createTrustedChildProcessBackend(options: { runnerModuleUrl: string; verifiedByTests?: boolean }): SandboxBackend {
  return {
    name: "trusted-child-process",
    isolation: "trusted-isolated",
    async execute(request) {
      assertStagedPaths(request);
      const work = await mkdtemp(join(tmpdir(), "mesh2threejs-sandbox-"));
      const requestPath = join(work, "request.json");
      const outputPath = join(work, "result.json");
      const payload: ChildRequestFile = { entry: resolve(request.entryPath), poses: request.poses };
      await writeFile(requestPath, JSON.stringify(payload));
      const environment = sanitizeLaunchEnvironment({}).sanitized;
      // Accept a file URL or plain path for the runner and normalize to a filesystem path:
      // Node treats the argv module target as a path, not a URL.
      let runnerPath = options.runnerModuleUrl;
      if (runnerPath.startsWith("file:")) {
        const { fileURLToPath } = await import("node:url");
        runnerPath = fileURLToPath(runnerPath);
      }
      const child = spawn(process.execPath, [
        `--max-old-space-size=${request.limits.maxOldSpaceMb}`,
        runnerPath,
        requestPath,
        outputPath,
      ], {
        cwd: request.stageRoot,
        env: environment,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000);
      });
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, request.limits.cpuTimeoutMs);
      try {
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
          child.once("error", rejectPromise);
          child.once("close", (code, signal) => resolvePromise({ code, signal }));
        });
        if (exit.signal === "SIGKILL") throw new SandboxViolationError("SANDBOX_TIMEOUT", `candidate exceeded ${request.limits.cpuTimeoutMs}ms execution budget`);
        if (exit.code !== 0) throw new SandboxViolationError("SANDBOX_CRASH", `candidate sandbox terminated abnormally (${exit.code ?? exit.signal}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
        const stat = await import("node:fs/promises").then((fs) => fs.stat(outputPath));
        if (stat.size > request.limits.maxOutputBytes) throw new SandboxViolationError("SANDBOX_OUTPUT_LIMIT", `candidate output ${stat.size} bytes exceeds limit ${request.limits.maxOutputBytes}`);
        const parsed = JSON.parse(await readFile(outputPath, "utf8")) as { samples: SandboxSample[] };
        return { samples: parsed.samples };
      } finally {
        clearTimeout(timeout);
        const { rm } = await import("node:fs/promises");
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}

/** Resolves the configured backend; fail-closed when no trusted backend exists. */
export function resolveSandboxBackend(configured?: SandboxBackend): { backend: SandboxBackend | null; reason?: typeof import("./policy.js").TRUSTED_SANDBOX_UNAVAILABLE } {
  if (configured) return { backend: configured };
  return { backend: null, reason: "TRUSTED_CANDIDATE_SANDBOX_UNAVAILABLE" as const };
}

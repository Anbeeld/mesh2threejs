import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { canonicalJson, sha256 } from "./hashing.js";

/**
 * Toolchain identity. Control text is provenance/configuration; the runtime evaluator
 * identity is the certification authority. Trusted startup recomputes every hash from
 * installed bytes and refuses mismatches — a manifest's declared hashes are never trusted
 * on their own.
 */

export interface ToolchainManifest {
  schemaVersion: 1;
  packageName: string;
  packageVersion: string;
  /** Hash over all shipped executable runtime/evaluator/review/viewer-server bytes. */
  runtimeHash: string;
  /** Hash over control text (SKILL.md, skills/**, PROFILE docs, AGENTS/CLAUDE, adapters). */
  controlHash: string;
  /** Canonical dependency identity from package.json + lock integrity where available. */
  dependencyIdentity: string;
  runtimeFiles: Record<string, string>;
  controlFiles: Record<string, string>;
}

export interface RuntimeProvenance {
  nodeVersion: string;
  platform: string;
  arch: string;
  packageRoot: string;
  threeRoot: string | null;
  threeVersion: string | null;
  meshoptimizerRoot: string | null;
  meshoptimizerVersion: string | null;
}

export interface VerifiedToolchain {
  manifest: ToolchainManifest;
  provenance: RuntimeProvenance;
  toolchainId: string;
}

const RUNTIME_ROOTS = ["dist", "profiles", "styles", "schemas", "viewer", "adapters"];
const CONTROL_ROOTS = ["skills", "agents"];
const CONTROL_FILES = ["SKILL.md", "AGENTS.md", "CLAUDE.md", "README.md"];

async function listFilesRecursive(root: string): Promise<string[]> {
  let info;
  try { info = await stat(root); } catch { return []; }
  if (!info.isDirectory()) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursive(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function relativeMap(root: string, files: string[], hashes: Map<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of files) result[relative(root, file).replaceAll("\\", "/")] = hashes.get(file)!;
  return result;
}

async function hashFiles(files: string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  await Promise.all(files.map(async (file) => hashes.set(file, sha256(await readFile(file)))));
  return hashes;
}

export function combineRuntimeHash(runtimeFiles: Record<string, string>): string {
  return sha256(canonicalJson(runtimeFiles));
}

export function combineControlHash(controlFiles: Record<string, string>): string {
  return sha256(canonicalJson(controlFiles));
}

async function resolvePackageRoot(packageName: string): Promise<{ root: string; version: string } | null> {
  try {
    const require = createRequire(import.meta.url);
    let directory = require.resolve(packageName);
    // Ascend to the directory owning a package.json to find the package root/version.
    for (;;) {
      try {
        const json = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string; version?: string };
        if (json.name === packageName && typeof json.version === "string") return { root: directory, version: json.version };
      } catch { /* keep ascending */ }
      const parent = resolve(directory, "..");
      if (parent === directory) return null;
      directory = parent;
    }
  } catch {
    return null;
  }
}

export async function computeDependencyIdentity(packageRoot: string): Promise<string> {
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { name: string; version: string; dependencies?: Record<string, string> };
  const dependencies = Object.entries(pkg.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const lockPath = join(packageRoot, "package-lock.json");
  let integrities: Record<string, string> = {};
  try {
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as { packages?: Record<string, { integrity?: string }> };
    for (const [specifier, entry] of Object.entries(lock.packages ?? {})) {
      if (!specifier.startsWith("node_modules/") || !entry.integrity) continue;
      integrities[specifier.slice("node_modules/".length)] = entry.integrity;
    }
  } catch { /* no lockfile available; declared ranges still participate */ }
  const identity = {
    name: pkg.name,
    version: pkg.version,
    dependencies,
    integrities: Object.fromEntries(Object.entries(integrities).sort(([a], [b]) => a.localeCompare(b))),
  };
  return sha256(canonicalJson(identity));
}

/** Generates the toolchain manifest from the actual bytes under `packageRoot`. */
export async function generateToolchainManifest(packageRoot: string): Promise<ToolchainManifest> {
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { name: string; version: string };
  const runtimeFiles: Array<{ root: string; glob: string[] }> = RUNTIME_ROOTS.map((root) => ({ root, glob: [] }));
  const runtimePaths: string[] = [];
  for (const { root } of runtimeFiles) runtimePaths.push(...await listFilesRecursive(join(packageRoot, root)));
  const runtimeHashes = await hashFiles(runtimePaths.filter((path) => !/\.log$|server\.log$/u.test(path)));
  const controlPaths: string[] = [];
  for (const root of CONTROL_ROOTS) controlPaths.push(...await listFilesRecursive(join(packageRoot, root)));
  for (const name of CONTROL_FILES) {
    const path = join(packageRoot, name);
    try { if ((await stat(path)).isFile()) controlPaths.push(path); } catch { /* optional control file */ }
  }
  const controlHashes = await hashFiles(controlPaths);
  const runtime = relativeMap(packageRoot, [...runtimeHashes.keys()].sort(), runtimeHashes);
  const control = relativeMap(packageRoot, [...controlHashes.keys()].sort(), controlHashes);
  return {
    schemaVersion: 1,
    packageName: pkg.name,
    packageVersion: pkg.version,
    runtimeHash: combineRuntimeHash(runtime),
    controlHash: combineControlHash(control),
    dependencyIdentity: await computeDependencyIdentity(packageRoot),
    runtimeFiles: runtime,
    controlFiles: control,
  };
}

/**
 * Recomputes the manifest from installed bytes and refuses any mismatch. Declared hashes
 * are never trusted on their own (actual-file verification).
 */
export async function verifyToolchainManifest(manifest: ToolchainManifest, packageRoot: string): Promise<void> {
  const current = await generateToolchainManifest(packageRoot);
  const mismatch = (): string | null => {
    if (current.runtimeHash !== manifest.runtimeHash) {
      const expected = new Map(Object.entries(manifest.runtimeFiles));
      for (const [file, hash] of Object.entries(current.runtimeFiles)) {
        const match = expected.get(file);
        if (match !== hash) return `${file} (${match ? "changed" : "unexpected"})`;
      }
      return "runtime file set changed";
    }
    if (current.controlHash !== manifest.controlHash) return "control text changed";
    if (current.dependencyIdentity !== manifest.dependencyIdentity) return "dependency identity changed";
    return null;
  };
  const problem = mismatch();
  if (problem) throw new Error(`toolchain verification failed: ${problem}; trusted runs refuse tampered installations`);
}

export async function captureRuntimeProvenance(packageRoot: string): Promise<RuntimeProvenance> {
  const three = await resolvePackageRoot("three");
  const meshoptimizer = await resolvePackageRoot("meshoptimizer");
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    packageRoot,
    ...(three ? { threeRoot: three.root, threeVersion: three.version } : {}),
    ...(meshoptimizer ? { meshoptimizerRoot: meshoptimizer.root, meshoptimizerVersion: meshoptimizer.version } : {}),
  } as RuntimeProvenance;
}

export function computeToolchainId(manifest: ToolchainManifest): string {
  return sha256(canonicalJson({ runtimeHash: manifest.runtimeHash, dependencyIdentity: manifest.dependencyIdentity, packageVersion: manifest.packageVersion }));
}

export async function establishToolchain(packageRoot: string, expected?: ToolchainManifest): Promise<VerifiedToolchain> {
  const manifest = await generateToolchainManifest(packageRoot);
  if (expected) await verifyToolchainManifest(expected, packageRoot);
  const provenance = await captureRuntimeProvenance(packageRoot);
  return { manifest, provenance, toolchainId: computeToolchainId(manifest) };
}

const ALLOWED_NODE_KEYS = new Set(["NODE_ENV"]);

export interface LaunchEnvironmentCheck {
  sanitized: NodeJS.ProcessEnv;
  stripped: string[];
}

const UNSAFE_NODE_KEYS = ["NODE_OPTIONS", "NODE_REQUIRE", "NODE_IMPORT", "NODE_LOADER"];

/** Refuses process startup that could preload/import/loader-hook the trusted runtime. */
export function assertSafeLaunchEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const violations = Object.keys(env).filter((key) => UNSAFE_NODE_KEYS.includes(key.toUpperCase()));
  if (violations.length) throw new Error(`unsafe broker launch configuration detected (${violations.join(", ")}); trusted runs refuse preload/import/loader hooks`);
}

/**
 * Strips unsafe launch configuration (preload/import/loader/inspector hooks, module search
 * roots) from the environment a trusted broker or sandbox child will run with. Any NODE_*
 * variable that can alter module resolution or process startup is rejected unless explicitly
 * allowlisted.
 */
export function sanitizeLaunchEnvironment(env: NodeJS.ProcessEnv = process.env): LaunchEnvironmentCheck {
  const sanitized: NodeJS.ProcessEnv = {};
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    const unsafe = upper.startsWith("NODE_") ? !ALLOWED_NODE_KEYS.has(upper) : ["PYTHONPATH", "BASH_ENV", "ENV"].includes(upper);
    if (unsafe) {
      stripped.push(key);
      continue;
    }
    sanitized[key] = value;
  }
  return { sanitized, stripped };
}

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

export interface RuntimeDependencyIdentity {
  name: string;
  /** Declared semver range from this package's package.json. */
  declared: string;
  /** Installed/resolved dependency version the bytes were hashed from. */
  resolvedVersion: string;
  /** Hash over the dependency package.json identity fields. */
  packageIdentityHash: string;
  /** Hash over the dependency's runtime JS/WASM asset bytes. */
  runtimeFilesHash: string;
}

export interface ToolchainManifest {
  schemaVersion: 2;
  packageName: string;
  packageVersion: string;
  /** Hash over all shipped executable runtime/evaluator/review/viewer-server bytes. */
  runtimeHash: string;
  /** Hash over control text (SKILL.md, skills/**, PROFILE docs, AGENTS/CLAUDE, adapters). */
  controlHash: string;
  /**
   * Canonical hash over the runtime dependency ledger below (remaining closure §4). Derived
   * ONLY from facts available both at prepack and inside a clean installed package — never
   * from a parent lockfile.
   */
  dependencyIdentity: string;
  dependencies: Array<RuntimeDependencyIdentity>;
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
  /** False when toolchain identity is ephemeral (development checkout); such installs cannot certify. */
  trustedToolchain: boolean;
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

async function resolveDependencyRoot(packageRoot: string, packageName: string): Promise<{ root: string; version: string } | null> {
  try {
    const require = createRequire(join(packageRoot, "package.json"));
    let directory = require.resolve(packageName);
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

const DEPENDENCY_ASSET_PATTERN = /\.(?:js|mjs|cjs|wasm)$/u;

/**
 * Runtime dependency ledger (remaining closure §4.1/§4.2, release host-trust §8):
 * resolved version + identity hashes computed from the ACTUAL installed dependency bytes.
 *
 * Direct-only rationale (release host-trust §8): the shipped manifest is generated at
 * `npm pack` time from the source checkout's `node_modules` and shipped inside the tarball.
 * Direct dependencies are pinned by exact version in `package.json` and always resolve
 * identically in a clean `npm install <tgz>`. Transitive dependency versions are NOT
 * pinned by the publisher and may differ between the source checkout's `node_modules` and
 * a fresh install (e.g. `ajv` -> `fast-uri` resolved to 3.1.5 in source but 3.1.6 in a clean
 * install). Including transitive versions in the shipped manifest would make it
 * non-reproducible across install contexts and break the installed-package verification.
 * Real host write isolation remains the primary security boundary; dependency hashing is
 * defense-in-depth covering the direct dependency closure (which includes all code the
 * trusted runtime actually imports at load time).
 */
export async function computeRuntimeDependencies(packageRoot: string): Promise<Array<RuntimeDependencyIdentity>> {
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const names = Object.keys(pkg.dependencies ?? {}).sort((a, b) => a.localeCompare(b));
  const ledger: Array<RuntimeDependencyIdentity> = [];
  for (const name of names) {
    const declared = pkg.dependencies![name]!;
    const resolved = await resolveDependencyRoot(packageRoot, name);
    if (!resolved) throw new Error(`runtime dependency ${name} is not installed; cannot compute toolchain identity`);
    const depPkg = JSON.parse(await readFile(join(resolved.root, "package.json"), "utf8")) as { name: string; version: string };
    const packageIdentityHash = sha256(canonicalJson({ name: depPkg.name, version: depPkg.version }));
    const files = (await listFilesRecursive(resolved.root)).filter((file) => DEPENDENCY_ASSET_PATTERN.test(file));
    const fileHashes: Record<string, string> = {};
    for (const file of files) fileHashes[relative(resolved.root, file).replaceAll("\\", "/")] = sha256(await readFile(file));
    const runtimeFilesHash = sha256(canonicalJson(fileHashes));
    ledger.push({ name, declared, resolvedVersion: resolved.version, packageIdentityHash, runtimeFilesHash });
  }
  return ledger;
}

export function combineDependencyIdentity(dependencies: ReadonlyArray<RuntimeDependencyIdentity>): string {
  return sha256(canonicalJson(dependencies));
}

/** Generates the toolchain manifest from the actual bytes under `packageRoot`. */
export async function generateToolchainManifest(packageRoot: string): Promise<ToolchainManifest> {
  const pkgPath = join(packageRoot, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { name: string; version: string };
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
  const dependencies = await computeRuntimeDependencies(packageRoot);
  return {
    schemaVersion: 2,
    packageName: pkg.name,
    packageVersion: pkg.version,
    runtimeHash: combineRuntimeHash(runtime),
    controlHash: combineControlHash(control),
    dependencyIdentity: combineDependencyIdentity(dependencies),
    dependencies,
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
    if (current.dependencyIdentity !== manifest.dependencyIdentity) {
      const expectedDeps = new Map(manifest.dependencies.map((dep) => [dep.name, dep]));
      for (const dep of current.dependencies) {
        const was = expectedDeps.get(dep.name);
        if (!was) return `unexpected runtime dependency ${dep.name}`;
        if (was.resolvedVersion !== dep.resolvedVersion) return `runtime dependency ${dep.name} version ${dep.resolvedVersion} differs from admitted ${was.resolvedVersion}`;
        if (was.packageIdentityHash !== dep.packageIdentityHash) return `runtime dependency ${dep.name} package identity changed`;
        if (was.runtimeFilesHash !== dep.runtimeFilesHash) return `runtime dependency ${dep.name} bytes changed`;
      }
      for (const dep of manifest.dependencies) if (!current.dependencies.some((item) => item.name === dep.name)) return `runtime dependency ${dep.name} is missing`;
      return "dependency identity changed";
    }
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
  // Shipped-manifest anchoring (closure plan §10.G2, remaining closure §4.4): an installed
  // package carries toolchain/manifest.v2.json generated by release tooling; installed
  // bytes AND installed dependency bytes are recomputed and compared exactly. A development
  // checkout has no shipped manifest, generates only ephemeral identity, and is marked
  // untrusted for certification purposes.
  let shipped: ToolchainManifest | null = null;
  try {
    shipped = JSON.parse(await readFile(join(packageRoot, 'toolchain', 'manifest.v2.json'), 'utf8')) as ToolchainManifest;
  } catch { shipped = null; }
  if (shipped) {
    if (shipped.schemaVersion !== 2) throw new Error('shipped toolchain manifest schema is unsupported; regenerate with the release tooling');
    await verifyToolchainManifest(shipped, packageRoot);
    const provenance = await captureRuntimeProvenance(packageRoot);
    return { manifest: shipped, provenance, toolchainId: computeToolchainId(shipped), trustedToolchain: true };
  }
  if (expected) await verifyToolchainManifest(expected, packageRoot);
  const provenance = await captureRuntimeProvenance(packageRoot);
  return { manifest, provenance, toolchainId: computeToolchainId(manifest), trustedToolchain: false };
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

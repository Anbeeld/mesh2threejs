import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile, appendFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Installed-package release proof (remaining closure §4.4/§12.3/§13):
 *
 *   build → npm pack → clean temp project → npm install <tgz>
 *   → installed mesh2threejs-broker startup reports trustedToolchain=true
 *   → both public binaries exist and respond
 *   → tampered installed runtime byte  → trusted startup FAILS
 *   → tampered runtime dependency byte → trusted startup FAILS
 *
 * No toolchainOverride, no source imports for the trust decision — this exercises exactly
 * what a customer installs.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const suppliedTgz = process.argv[2];

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

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function main(): Promise<void> {
  // ---- 1. pack -------------------------------------------------------------------
  const scratch = await mkdtemp(join(tmpdir(), "mesh2threejs-installed-"));
  let tgz = suppliedTgz ? resolve(suppliedTgz) : "";
  if (!tgz) {
    console.log("[installed-package] packing (prepack validates + generates the shipped manifest)...");
    const packed = await run("npm", ["pack"], REPO_ROOT);
    if (packed.code !== 0) throw new Error(`npm pack failed:\n${packed.stdout}`);
    const lines = packed.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith(".tgz"));
    if (!lines.length) throw new Error(`npm pack produced no tarball name:\n${packed.stdout.slice(-2000)}`);
    tgz = join(REPO_ROOT, lines[lines.length - 1]!);
  }
  if (!(await exists(tgz))) throw new Error(`tarball not found: ${tgz}`);
  console.log(`[installed-package] tarball: ${tgz}`);

  try {
    // ---- 2. clean install ----------------------------------------------------------
    const project = join(scratch, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "mesh2threejs-install-check", private: true, version: "1.0.0" }, null, 2)}\n`);
    const install = await run("npm", ["install", tgz], project);
    if (install.code !== 0) throw new Error(`npm install failed:\n${install.stdout.slice(-4000)}`);
    const installedRoot = join(project, "node_modules", "mesh2threejs");

    // ---- 3. both binaries exist ----------------------------------------------------
    const binDir = join(project, "node_modules", ".bin");
    const binExt = process.platform === "win32" ? ".cmd" : "";
    for (const name of ["mesh2threejs", "mesh2threejs-broker"]) {
      if (!(await exists(join(binDir, `${name}${binExt}`))) && !(await exists(join(binDir, name)))) {
        throw new Error(`installed package does not expose binary ${name}`);
      }
    }
    const cliHelp = await run(process.execPath, [join(installedRoot, "dist", "cli.js"), "--help"], project);
    if (cliHelp.code !== 0) throw new Error(`installed mesh2threejs --help failed:\n${cliHelp.stdout.slice(-2000)}`);
    console.log("[installed-package] binaries verified (mesh2threejs, mesh2threejs-broker)");

    // ---- 4. broker startup must be TRUSTED -----------------------------------------
    const store = join(scratch, "store");
    await mkdir(store, { recursive: true });
    const brokerJs = join(installedRoot, "dist", "broker", "main.js");
    const firstStart = await run(process.execPath, [brokerJs, "--store", store], project, 120_000);
    if (!/TOOLCHAIN trusted=true/.test(firstStart.stdout)) {
      throw new Error(`installed broker did NOT anchor a trusted toolchain:\n${firstStart.stdout.slice(-3000)}`);
    }
    console.log("[installed-package] installed broker startup: trustedToolchain=true");

    // ---- 5. runtime byte tamper fails closed ---------------------------------------
    await appendFile(join(installedRoot, "dist", "core", "toolchain.js"), "\n// tampered\n");
    const tamperedStart = await run(process.execPath, [brokerJs, "--store", store], project, 120_000);
    if (/TOOLCHAIN trusted=true/.test(tamperedStart.stdout)) throw new Error("tampered installation still reported a trusted toolchain");
    if (!/toolchain verification failed/i.test(tamperedStart.stdout)) throw new Error(`tampered installation failed without a toolchain verification error:\n${tamperedStart.stdout.slice(-3000)}`);
    console.log("[installed-package] tampered runtime byte refused at trusted startup");
    await writeFile(join(installedRoot, "dist", "core", "toolchain.js"), (await readFile(join(installedRoot, "dist", "core", "toolchain.js"), "utf8")).replace("\n// tampered\n", ""));

    // ---- 6. dependency byte tamper fails closed ------------------------------------
    const threeEntry = join(installedRoot, "..", "..", "node_modules", "three", "build", "three.module.js");
    const depTarget = (await exists(threeEntry)) ? threeEntry : null;
    if (!depTarget) throw new Error("could not locate installed three module build for the dependency tamper check");
    await appendFile(depTarget, "\n// tampered\n");
    const depTamperedStart = await run(process.execPath, [brokerJs, "--store", store], project, 120_000);
    if (/TOOLCHAIN trusted=true/.test(depTamperedStart.stdout)) throw new Error("installation with a tampered runtime dependency still reported a trusted toolchain");
    if (!/runtime dependency .* bytes changed|toolchain verification failed/i.test(depTamperedStart.stdout)) {
      throw new Error(`dependency tamper failed without a dependency verification error:\n${depTamperedStart.stdout.slice(-3000)}`);
    }
    console.log("[installed-package] tampered runtime dependency refused at trusted startup");
    await writeFile(depTarget, (await readFile(depTarget, "utf8")).replace("\n// tampered\n", ""));
    console.log("[installed-package] PASS: shipped trust survives packaging/install and refuses tampering");
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

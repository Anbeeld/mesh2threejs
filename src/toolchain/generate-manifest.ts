import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateToolchainManifest } from "../core/toolchain.js";

/**
 * Release tooling (closure plan §10.G2, remaining closure §4.3/§10, final closure §10):
 * generates the immutable shipped toolchain manifest at the pack/build boundary. The
 * artifact is written to `toolchain/manifest.v2.json` and included in npm pack; installed
 * trusted startups recompute installed bytes (including runtime dependency bytes) and refuse
 * any mismatch. Development checkouts do not carry this file and self-generate only
 * ephemeral, non-certifying identity. Generation is IDEMPOTENT: an existing artifact is
 * atomically replaced, never treated as an input, so repeated `npm pack` runs succeed in the
 * same checkout. The temp file is created INSIDE `toolchain/` (same filesystem) to avoid
 * cross-volume rename failures.
 */

const packageRoot = resolve(process.argv[2] ?? ".");
const manifest = await generateToolchainManifest(packageRoot);
const toolchainDir = resolve(packageRoot, "toolchain");
await mkdir(toolchainDir, { recursive: true });
const target = join(toolchainDir, "manifest.v2.json");
// Same-filesystem atomic replacement (final closure §10): write temp inside toolchain/,
// then rename into place. Cross-filesystem rename can fail on some OS/volume combinations.
const temporary = join(toolchainDir, `.manifest.v2.json.${process.pid}.tmp`);
await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
await rename(temporary, target);
console.log(`shipped toolchain manifest written (${Object.keys(manifest.runtimeFiles).length} runtime files, ${Object.keys(manifest.controlFiles).length} control files, ${manifest.dependencies.length} runtime dependencies)`);

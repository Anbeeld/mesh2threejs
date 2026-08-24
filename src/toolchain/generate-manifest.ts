import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateToolchainManifest } from "../core/toolchain.js";

/**
 * Release tooling (closure plan §10.G2, remaining closure §4.3/§10): generates the immutable
 * shipped toolchain manifest at the pack/build boundary. The artifact is written to
 * `toolchain/manifest.v2.json` and included in npm pack; installed trusted startups recompute
 * installed bytes (including runtime dependency bytes) and refuse any mismatch. Development
 * checkouts do not carry this file and self-generate only ephemeral, non-certifying identity.
 * Generation is IDEMPOTENT: an existing artifact is atomically replaced, never treated as an
 * input, so repeated `npm pack` runs succeed in the same checkout.
 */

const packageRoot = resolve(process.argv[2] ?? ".");
const manifest = await generateToolchainManifest(packageRoot);
await mkdir(resolve(packageRoot, "toolchain"), { recursive: true });
const target = resolve(packageRoot, "toolchain", "manifest.v2.json");
const scratch = await mkdtemp(join(tmpdir(), "mesh2threejs-manifest-"));
try {
  const temporary = join(scratch, "manifest.v2.json");
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(target, { force: true });
  await rename(temporary, target);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log(`shipped toolchain manifest written (${Object.keys(manifest.runtimeFiles).length} runtime files, ${Object.keys(manifest.controlFiles).length} control files, ${manifest.dependencies.length} runtime dependencies)`);

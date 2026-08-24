import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateToolchainManifest } from "../core/toolchain.js";

/**
 * Release tooling (closure plan §10.G2): generates the immutable shipped toolchain manifest
 * at the pack/build boundary. The artifact is written to `toolchain/manifest.v1.json` and
 * included in npm pack; installed trusted startups recompute installed bytes and refuse any
 * mismatch. Development checkouts do not carry this file and self-generate only ephemeral,
 * non-certifying identity.
 */

const packageRoot = resolve(process.argv[2] ?? ".");
const manifest = await generateToolchainManifest(packageRoot);
await mkdir(resolve(packageRoot, "toolchain"), { recursive: true });
await writeFile(resolve(packageRoot, "toolchain", "manifest.v1.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(`shipped toolchain manifest written (${manifest.runtimeFiles.length} runtime files, ${manifest.controlFiles.length} control files)`);

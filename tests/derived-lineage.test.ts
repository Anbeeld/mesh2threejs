import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test, afterAll } from "vitest";
import { sha256 } from "../src/core/hashing.js";
import {
  GENERATED_DIRECTORY,
  GENERATED_REGISTRY_PATH,
  MODEL_DERIVED_SCAFFOLD,
  derivationManifestHash,
  generateRegistrySource,
  loadTrustedGeneratedModules,
  verifyDerivedLineage,
  derivedDirectory,
  type DerivationManifest,
} from "../src/core/derivation.js";

/**
 * Derived-lineage attacks (plan §22 attacks 36–42). Lineage authority is STRUCTURAL:
 * canonical scaffold entry + pipeline registry + five-way generated bindings. A forged
 * runtime userData marker can never substitute for any of it.
 */

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const PREPARATION = "prep-1";

interface Fixture {
  root: string;
  manifest: (overrides?: Partial<DerivationManifest>) => DerivationManifest;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "mesh2threejs-lineage-"));
  roots.push(root);
  await mkdir(join(root, GENERATED_DIRECTORY), { recursive: true });
  await mkdir(derivedDirectory(join(root, ".mesh2threejs")), { recursive: true });
  return {
    root,
    manifest: (overrides = {}) => ({
      schemaVersion: 1,
      kind: "mesh2threejs-derived-seed",
      phase: "hull",
      oraclePreparationIdentity: PREPARATION,
      preparedOracleHash: "prepared-1",
      operator: "mesh-simplify",
      recipe: {},
      inputGeometryHash: "in",
      outputGeometryHash: "out",
      generatedModulePath: `${GENERATED_DIRECTORY}/hull.mjs`,
      generatedModuleHash: "",
      inputTriangles: 100,
      outputTriangles: 10,
      ...overrides,
    }),
  };
}

async function writeDerived(fx: Fixture, moduleSource: string): Promise<{ bindingKey: string; manifest: DerivationManifest }> {
  const modulePath = join(fx.root, GENERATED_DIRECTORY, "hull.mjs");
  const manifest = fx.manifest({ generatedModuleHash: sha256(Buffer.from(moduleSource, "utf8")) });
  await writeFile(modulePath, moduleSource);
  await writeFile(join(fx.root, GENERATED_REGISTRY_PATH), generateRegistrySource("tank", ["hull"]));
  await writeFile(join(derivedDirectory(join(fx.root, ".mesh2threejs")), "hull.json"), JSON.stringify(manifest));
  // Canonical derived entry.
  const modelDir = join(fx.root, "model");
  await mkdir(modelDir, { recursive: true });
  await writeFile(join(modelDir, "model.mjs"), MODEL_DERIVED_SCAFFOLD);
  return { bindingKey: `${GENERATED_DIRECTORY}/hull.mjs`, manifest };
}

function bindingsFor(manifest: DerivationManifest): Record<string, import("../src/core/state.js").DerivedBinding> {
  return {
    [`${GENERATED_DIRECTORY}/hull.mjs`]: {
      manifestHash: derivationManifestHash(manifest),
      generatedModuleHash: manifest.generatedModuleHash,
      oraclePreparationIdentity: PREPARATION,
    },
  };
}

async function trustedModules(fx: Fixture, bindings: Record<string, import("../src/core/state.js").DerivedBinding>, preparationIdentity = PREPARATION) {
  return loadTrustedGeneratedModules({
    directory: derivedDirectory(join(fx.root, ".mesh2threejs")),
    workspaceRoot: fx.root,
    preparationIdentity,
    bindings,
    allowedPhases: new Set(["hull", "turret", "gun", "running-gear", "tracks"]),
  });
}

describe("derived lineage structural authority (§10)", () => {
  test("a consistent pipeline-owned composition verifies", async () => {
    const fx = await fixture();
    const { manifest } = await writeDerived(fx, `// trusted seed\nexport function createSeed(){ return null; }\n`);
    const bindings = bindingsFor(manifest);
    const trusted = await trustedModules(fx, bindings);
    expect(trusted.size).toBe(1);
    await expect(verifyDerivedLineage({
      modelEntryPath: join(fx.root, "model", "model.mjs"),
      workspaceRoot: fx.root,
      profile: "tank",
      authorshipMode: "derived",
      derivedBindings: bindings,
      trustedModules: trusted,
    })).resolves.toBeUndefined();
  });

  test("replacing the canonical derived entry is a violation (attack 37)", async () => {
    const fx = await fixture();
    const { manifest } = await writeDerived(fx, `export function createSeed(){ return null; }`);
    await writeFile(join(fx.root, "model", "model.mjs"), `export function createCandidate(){ return new (require('three').Group)(); }`);
    await expect(verifyDerivedLineage({
      modelEntryPath: join(fx.root, "model", "model.mjs"),
      workspaceRoot: fx.root,
      profile: "tank",
      authorshipMode: "derived",
      derivedBindings: bindingsFor(manifest),
      trustedModules: await trustedModules(fx, bindingsFor(manifest)),
    })).rejects.toThrow(/canonical derived model entry was replaced/i);
  });

  test("hand-edited generated registry is a violation (attack 38)", async () => {
    const fx = await fixture();
    const { manifest } = await writeDerived(fx, `export function createSeed(){ return null; }`);
    await writeFile(join(fx.root, GENERATED_REGISTRY_PATH), `${generateRegistrySource("tank", ["hull"])}\n// builder was here\n`);
    await expect(verifyDerivedLineage({
      modelEntryPath: join(fx.root, "model", "model.mjs"),
      workspaceRoot: fx.root,
      profile: "tank",
      authorshipMode: "derived",
      derivedBindings: bindingsFor(manifest),
      trustedModules: await trustedModules(fx, bindingsFor(manifest)),
    })).rejects.toThrow(/registry does not match trusted derive state/i);
  });

  test("deleting the generated module or its state binding fails five-way authority (attacks 36/40)", async () => {
    const fx = await fixture();
    const { manifest } = await writeDerived(fx, `export function createSeed(){ return null; }`);
    const bindings = bindingsFor(manifest);
    // Delete the module file.
    await rm(join(fx.root, GENERATED_DIRECTORY, "hull.mjs"));
    let trusted = await trustedModules(fx, bindings);
    expect(trusted.size).toBe(0);
    await expect(verifyDerivedLineage({
      modelEntryPath: join(fx.root, "model", "model.mjs"),
      workspaceRoot: fx.root,
      profile: "tank",
      authorshipMode: "derived",
      derivedBindings: bindings,
      trustedModules: trusted,
    })).rejects.toThrow(/five-way authority verification/i);

    // Fake manifest WITHOUT durable authority binding (attack 40).
    await writeDerived(fx, `export function createSeed(){ return null; }`);
    trusted = await trustedModules(fx, {});
    expect(trusted.size).toBe(0);
  });

  test("a stale generated module (bytes changed after derive) fails (attack 41)", async () => {
    const fx = await fixture();
    const { manifest } = await writeDerived(fx, `export function createSeed(){ return null; }`);
    await writeFile(join(fx.root, GENERATED_DIRECTORY, "hull.mjs"), `export function createSeed(){ return { tampered: true }; }`);
    await expect(verifyDerivedLineage({
      modelEntryPath: join(fx.root, "model", "model.mjs"),
      workspaceRoot: fx.root,
      profile: "tank",
      authorshipMode: "derived",
      derivedBindings: bindingsFor(manifest),
      trustedModules: await trustedModules(fx, bindingsFor(manifest)),
    })).rejects.toThrow(/five-way authority verification/i);
  });

  test("a preparation change invalidates prior derivation bindings (attack 42)", async () => {
    const fx = await fixture();
    const { manifest } = await writeDerived(fx, `export function createSeed(){ return null; }`);
    const trusted = await trustedModules(fx, bindingsFor(manifest), "prep-2");
    expect(trusted.size).toBe(0);
    await expect(verifyDerivedLineage({
      modelEntryPath: join(fx.root, "model", "model.mjs"),
      workspaceRoot: fx.root,
      profile: "tank",
      authorshipMode: "derived",
      derivedBindings: bindingsFor(manifest),
      trustedModules: trusted,
    })).rejects.toThrow();
  });

  test("lineage never consults runtime userData markers — structural checks only (Gap E)", async () => {
    const fx = await fixture();
    const markerSource = `// no userData.mesh2threejsDerivation marker anywhere\nexport const userData = {}; export function createSeed(){ return null; }`;
    const { manifest } = await writeDerived(fx, markerSource);
    await expect(verifyDerivedLineage({
      modelEntryPath: join(fx.root, "model", "model.mjs"),
      workspaceRoot: fx.root,
      profile: "tank",
      authorshipMode: "derived",
      derivedBindings: bindingsFor(manifest),
      trustedModules: await trustedModules(fx, bindingsFor(manifest)),
    })).resolves.toBeUndefined();
  });
});

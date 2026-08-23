import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, sha256 } from "./hashing.js";

/**
 * Pipeline-owned provenance for one generated seed module. A manifest is candidate
 * provenance/configuration, not certification evidence: it exists so the audit can tell
 * trusted pipeline-generated geometry apart from hand-authored payloads, and so stale or
 * tampered artifacts fail closed against the current oracle preparation.
 */
export interface DerivationManifest {
  schemaVersion: 1;
  kind: "mesh2threejs-derived-seed";
  phase: string;
  oraclePreparationIdentity: string;
  preparedOracleHash: string;
  operator: "mesh-simplify" | "radial-fit" | "course-regenerate" | "axis-fit";
  recipe: Record<string, unknown>;
  inputGeometryHash: string;
  outputGeometryHash: string;
  /** Workspace-relative path of the generated module this manifest binds. */
  generatedModulePath: string;
  generatedModuleHash: string;
  inputTriangles: number;
  outputTriangles: number;
  /** Relative geometric error reported by the simplifier for the selected tier. */
  simplifierError?: number;
}

/** Workspace directory holding derivation manifests, keyed one per generated module. */
export function derivedDirectory(internalRoot: string): string {
  return join(internalRoot, "derived");
}

export function derivationManifestHash(manifest: DerivationManifest): string {
  return sha256(canonicalJson(manifest));
}

function isDerivationManifest(value: unknown): value is DerivationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<DerivationManifest>;
  return manifest.schemaVersion === 1
    && manifest.kind === "mesh2threejs-derived-seed"
    && typeof manifest.phase === "string"
    && typeof manifest.oraclePreparationIdentity === "string"
    && typeof manifest.preparedOracleHash === "string"
    && typeof manifest.operator === "string"
    && typeof manifest.inputGeometryHash === "string"
    && typeof manifest.outputGeometryHash === "string"
    && typeof manifest.generatedModulePath === "string"
    && typeof manifest.generatedModuleHash === "string"
    && Number.isFinite(manifest.inputTriangles)
    && Number.isFinite(manifest.outputTriangles);
}

export interface TrustedGeneratedModule {
  manifestPath: string;
  manifestHash: string;
  manifest: DerivationManifest;
}

/**
 * Loads every derivation manifest under `<workspace>/.mesh2threejs/derived`, keeping only
 * manifests that are (1) structurally valid, (2) bound to the CURRENT oracle preparation
 * identity, and (3) still byte-identical to the generated module they bind. Everything else
 * is silently dropped, which makes unverified generated files fall back to ordinary
 * hand-authored audit rules and fail closed on dense payloads.
 */
export async function loadTrustedGeneratedModules(directory: string, workspaceRoot: string, oraclePreparationIdentity: string): Promise<Map<string, TrustedGeneratedModule>> {
  const trusted = new Map<string, TrustedGeneratedModule>();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return trusted;
  }
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const manifestPath = join(directory, name);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!isDerivationManifest(value)) continue;
    if (value.oraclePreparationIdentity !== oraclePreparationIdentity) continue;
    const modulePath = resolve(workspaceRoot, value.generatedModulePath);
    let bytes: Buffer;
    try {
      bytes = await readFile(modulePath);
    } catch {
      continue;
    }
    if (sha256(bytes) !== value.generatedModuleHash) continue;
    trusted.set(modulePath, { manifestPath, manifestHash: derivationManifestHash(value), manifest: value });
  }
  return trusted;
}

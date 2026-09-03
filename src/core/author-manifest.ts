import { canonicalJson, sha256 } from "./hashing.js";

/**
 * Authored manifest provenance (stylized-authored mode design §10). A manifest is candidate
 * provenance/configuration, NOT certification evidence: it binds one authored semantic to its
 * spec, compiler version, generated module bytes, geometry, and materials so stale or tampered
 * artifacts fail closed. Every authored manifest binds AuthorSpec hash, compiler version,
 * semantic, generated module hash, geometry hash, and material hash.
 */

/** Canonical workspace-relative directory of builder-authored AuthorSpec files. */
export const AUTHOR_SPEC_DIRECTORY = "model/stylized";
/** Workspace directory holding authored manifests, keyed one per authored semantic. */
export const AUTHOR_MANIFEST_DIRECTORY = ".mesh2threejs/authored/manifests";

export interface AuthoredManifest {
  schemaVersion: 1;
  kind: "mesh2threejs-authored-part";
  semanticId: string;
  parentSemanticId: string | null;
  compilerVersion: string;
  authorSpecHash: string;
  generatedModulePath: string;
  generatedModuleHash: string;
  geometryHash: string;
  materialHash: string;
  triangleCount: number;
  vertexCount: number;
  partNames: string[];
}

export function authoredManifestHash(manifest: AuthoredManifest): string {
  return sha256(canonicalJson(manifest));
}

export function isAuthoredManifest(value: unknown): value is AuthoredManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<AuthoredManifest>;
  return manifest.schemaVersion === 1
    && manifest.kind === "mesh2threejs-authored-part"
    && typeof manifest.semanticId === "string"
    && typeof manifest.compilerVersion === "string"
    && typeof manifest.authorSpecHash === "string"
    && typeof manifest.generatedModulePath === "string"
    && typeof manifest.generatedModuleHash === "string"
    && typeof manifest.geometryHash === "string"
    && typeof manifest.materialHash === "string"
    && Number.isFinite(manifest.triangleCount)
    && Number.isFinite(manifest.vertexCount)
    && Array.isArray(manifest.partNames);
}
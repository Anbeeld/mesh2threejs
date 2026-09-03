import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { canonicalJson, sha256 } from "./hashing.js";
import type { ReferenceIndex } from "./workspace.js";
import { ConstructionRoutingError } from "./construction-mode.js";

/**
 * Style reference binding (stylized-authored mode design §14). Heavy stylization has a second
 * reference authority: the oracle constrains geometry/proportions/placement; style references
 * constrain abstraction/shape language/detail retention. Neither silently substitutes for the
 * other (design invariant 3). The binding is immutable per freeze: a style file mutation
 * after freeze invalidates downstream state.
 */

export const STYLE_DIRECTORY = "style";
export const STYLE_REFERENCES_PATH = `${STYLE_DIRECTORY}/references.json`;
export const STYLE_BRIEF_PATH = `${STYLE_DIRECTORY}/brief.md`;
export const STYLE_REFS_DIRECTORY = "refs/style";

export interface StyleReferenceEntry {
  path: string;
  role: string;
  notes?: string;
}

export interface StyleReferencesManifest {
  schemaVersion: 1;
  references: StyleReferenceEntry[];
}

export interface StyleBinding {
  schemaVersion: 1;
  kind: "mesh2threejs-style-binding";
  styleReferenceSetHash: string;
  styleBriefHash: string;
  styleBindingHash: string;
  references: Array<{ path: string; sha256: string; role: string }>;
  briefPath: string | null;
}

export function parseStyleReferences(value: unknown): StyleReferencesManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", "style/references.json must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", "style/references.json schemaVersion must be 1");
  if (!Array.isArray(record.references) || !record.references.length) {
    throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", "style/references.json must list at least one style reference");
  }
  const references: StyleReferenceEntry[] = [];
  for (const raw of record.references) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", "style reference entries must be objects");
    const entry = raw as Record<string, unknown>;
    if (typeof entry.path !== "string" || !entry.path.trim()) throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", "style reference path must be a non-empty string");
    if (typeof entry.role !== "string" || !entry.role.trim()) throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", "style reference role must be a non-empty string");
    references.push({
      path: entry.path,
      role: entry.role,
      ...(typeof entry.notes === "string" ? { notes: entry.notes } : {}),
    });
  }
  return { schemaVersion: 1, references };
}

/**
 * Computes the immutable style binding from workspace files: every referenced style image
 * must exist under `refs/style/`, be indexed in the reference index, and hash to its indexed
 * value. The binding hash covers the reference set bytes and the brief bytes, so ANY style
 * input change changes the binding and invalidates a freeze.
 */
export async function computeStyleBinding(workspaceRoot: string, references: ReferenceIndex, options: { requireBrief?: boolean } = {}): Promise<StyleBinding> {
  const manifestPath = resolve(workspaceRoot, STYLE_REFERENCES_PATH);
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", `no style reference manifest exists at ${STYLE_REFERENCES_PATH}; register style references before authoring freezes`);
  }
  const manifest = parseStyleReferences(manifestValue);
  const bound: StyleBinding["references"] = [];
  for (const entry of manifest.references) {
    const normalized = entry.path.replaceAll("\\", "/");
    // Registered workspace image references live under refs/style/ (canonical style pack
    // location, design §14.1) or refs/images/ (the workspace image directory the
    // initializer creates); both are style authority, everything else is refused.
    if ((!normalized.startsWith("refs/style/") && !normalized.startsWith("refs/images/")) || normalized.includes("..")) {
      throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", `style reference path must live under refs/style/ or refs/images/: ${entry.path}`);
    }
    const absolute = resolve(workspaceRoot, normalized);
    const relation = relative(resolve(workspaceRoot), absolute);
    if (relation.startsWith("..")) throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", `style reference escapes the workspace: ${entry.path}`);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch {
      throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", `style reference file is missing: ${entry.path}`);
    }
    const hash = sha256(bytes);
    const indexed = references.records.find((record) => record.kind === "image" && record.operationalPath.replaceAll("\\", "/") === normalized);
    if (!indexed) {
      throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", `style reference ${entry.path} is absent from the reference index; register it as a workspace image reference`);
    }
    if (indexed.sha256 !== hash) {
      throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", `style reference ${entry.path} changed after registration; re-register and rebind`);
    }
    bound.push({ path: normalized, sha256: hash, role: entry.role });
  }
  const briefPath = join(workspaceRoot, STYLE_BRIEF_PATH);
  let briefHash: string | null = null;
  try {
    briefHash = sha256(await readFile(briefPath));
  } catch {
    if (options.requireBrief) {
      throw new ConstructionRoutingError("STYLE_BINDING_REQUIRED", `no style brief exists at ${STYLE_BRIEF_PATH}; a stylized run requires a written style direction`);
    }
  }
  const binding: StyleBinding = {
    schemaVersion: 1,
    kind: "mesh2threejs-style-binding",
    styleReferenceSetHash: sha256(canonicalJson({ references: bound })),
    styleBriefHash: briefHash ?? "",
    styleBindingHash: "",
    references: bound,
    briefPath: briefHash ? STYLE_BRIEF_PATH : null,
  };
  binding.styleBindingHash = sha256(canonicalJson({
    kind: binding.kind,
    styleReferenceSetHash: binding.styleReferenceSetHash,
    styleBriefHash: binding.styleBriefHash,
  }));
  return binding;
}

/** Verifies a recorded style binding still matches the live style input bytes. */
/**
 * Verifies a recorded style binding against the LIVE style input. Immutability covers the
 * whole binding, not just recorded bytes: the manifest is RE-READ and the live binding is
 * RECOMPUTED from the current manifest + reference index, so changing WHICH images are
 * listed, their roles, or adding/removing entries changes the live styleBindingHash and is
 * refused even when the previously recorded image files are untouched.
 */
export async function verifyStyleBindingCurrent(workspaceRoot: string, recorded: StyleBinding): Promise<void> {
  // Recompute the live binding from the current manifest + reference index.
  let referenceIndex: ReferenceIndex;
  try {
    referenceIndex = JSON.parse(await readFile(resolve(workspaceRoot, ".mesh2threejs/references.json"), "utf8")) as ReferenceIndex;
  } catch {
    throw new ConstructionRoutingError("FREEZE_STALE", "the workspace reference index is unreadable; cannot re-verify the bound style input");
  }
  if (!referenceIndex || !Array.isArray(referenceIndex.records)) {
    throw new ConstructionRoutingError("FREEZE_STALE", "the workspace reference index is invalid; cannot re-verify the bound style input");
  }
  const live = await computeStyleBinding(workspaceRoot, referenceIndex);
  if (live.styleBindingHash !== recorded.styleBindingHash) {
    throw new ConstructionRoutingError("FREEZE_STALE", "the style binding changed after freeze (manifest roles/entries, reference bytes, or brief); reopen authoring and re-freeze");
  }
  // Defense in depth: each recorded file must still exist with its recorded bytes.
  for (const reference of recorded.references) {
    let hash: string;
    try {
      hash = sha256(await readFile(resolve(workspaceRoot, reference.path)));
    } catch {
      throw new ConstructionRoutingError("FREEZE_STALE", `bound style reference is missing: ${reference.path}; reopen authoring and re-freeze`);
    }
    if (hash !== reference.sha256) {
      throw new ConstructionRoutingError("FREEZE_STALE", `bound style reference bytes changed: ${reference.path}; reopen authoring and re-freeze`);
    }
  }
  if (recorded.briefPath) {
    let hash: string;
    try {
      hash = sha256(await readFile(resolve(workspaceRoot, recorded.briefPath)));
    } catch {
      throw new ConstructionRoutingError("FREEZE_STALE", "bound style brief is missing; reopen authoring and re-freeze");
    }
    if (hash !== recorded.styleBriefHash) {
      throw new ConstructionRoutingError("FREEZE_STALE", "style brief bytes changed after freeze; reopen authoring and re-freeze");
    }
  }
}
export function styleBindingHash(binding: StyleBinding): string {
  return binding.styleBindingHash;
}
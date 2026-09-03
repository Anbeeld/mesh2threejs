import { readFile, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, sha256 } from "./hashing.js";
import { candidateImportViolation, ConstructionRoutingError, deriveAllowedIn, effectiveConstructionMode } from "./construction-mode.js";
import { AUTHOR_SPEC_DIRECTORY, AUTHOR_MANIFEST_DIRECTORY, authoredManifestHash, type AuthoredManifest } from "./author-manifest.js";
import { compileAuthorSpec, emitAuthoredModule, AUTHORED_GENERATED_DIRECTORY, AUTHORED_REGISTRY_PATH, generateAuthoredRegistrySource, MODEL_STYLIZED_SCAFFOLD } from "./author-compiler.js";
import { validateAuthorSpec, AUTHOR_SPEC_SCHEMA_VERSION, AUTHORED_COMPILER_VERSION, type AuthorSpec } from "./author-spec.js";
import type { ConstructionMode } from "../types.js";

/**
 * Authored candidate composition (stylized-authored mode design §10/§16). The authored
 * binding ledger is DISTINCT from `derivedBindings`: a stylized run composes ONLY authored
 * manifests, and no manifest sidecar may introduce a source-derived module. Candidate
 * composition must never read `.mesh2threejs/oracle/`, `.mesh2threejs/reference-view/`, or
 * `refs/` — the compiler never receives oracle geometry, so copied geometry has no route
 * into the candidate (design invariant 1/6, §16.1).
 */

export { AUTHOR_SPEC_DIRECTORY, AUTHOR_MANIFEST_DIRECTORY, AUTHORED_GENERATED_DIRECTORY, AUTHORED_REGISTRY_PATH, MODEL_STYLIZED_SCAFFOLD };

/** One trusted authored module binding, recorded only by trusted author-compile code. */
export interface AuthoredBinding {
  semanticId: string;
  authorSpecHash: string;
  authoredManifestHash: string;
  generatedModuleHash: string;
  geometryHash: string;
  materialHash: string;
  compilerVersion: string;
  parentSemanticId: string | null;
}

export function authoredBindingKey(semanticId: string): string {
  return `${AUTHORED_GENERATED_DIRECTORY}/${semanticId}.mjs`.replaceAll("\\", "/");
}

/** Discovers authored AuthorSpec files under `model/stylized/` (one file per semantic, design Q1). */
export async function discoverAuthorSpecs(workspaceRoot: string): Promise<Array<{ semanticId: string; path: string }>> {
  const directory = resolve(workspaceRoot, AUTHOR_SPEC_DIRECTORY);
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ semanticId: basename(name, ".json"), path: `${AUTHOR_SPEC_DIRECTORY}/${name}` }));
}

export async function readAuthorSpec(workspaceRoot: string, path: string): Promise<AuthorSpec> {
  const specPath = resolve(workspaceRoot, path);
  const relation = relative(resolve(workspaceRoot), specPath);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `author spec path escapes the workspace: ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(specPath, "utf8"));
  } catch (error) {
    throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `author spec ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).schemaVersion !== AUTHOR_SPEC_SCHEMA_VERSION) {
    // validateAuthorSpec re-checks this; the early check just produces a clearer message.
  }
  const spec = validateAuthorSpec(value);
  const expectedSemantic = basename(path, ".json");
  if (spec.semanticId !== expectedSemantic) {
    throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `author spec file ${path} must be named after its semanticId (${spec.semanticId})`);
  }
  return spec;
}

/**
 * Validates the semantic graph of a full authored composition. CLEAN RULE (design §28.1):
 * EVERY `parentSemanticId` must itself have an AuthorSpec — pivots are explicitly authored
 * as zero-geometry `group` specs with oracle-measured origins, because the authored registry
 * composes ONLY authored objects and an unauthored parent would silently leave the child
 * unparented at runtime. The oracle is the measurement source for pivot origins, never the
 * parenting authority. Duplicate roots, illegal group parents, and cycles fail closed.
 */
export function validateAuthoredSemanticGraph(specs: AuthorSpec[]): { ordered: AuthorSpec[]; pivotNestings: Array<readonly [string, string]> } {
  const byId = new Map<string, AuthorSpec>();
  for (const spec of specs) {
    if (byId.has(spec.semanticId)) throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `duplicate authored semantic root: ${spec.semanticId}`);
    byId.set(spec.semanticId, spec);
  }
  const parentOf = (semanticId: string): string | null => byId.get(semanticId)?.parentSemanticId ?? null;
  for (const spec of specs) {
    const parent = spec.parentSemanticId;
    if (!parent) continue;
    const parentSpec = byId.get(parent);
    if (!parentSpec) {
      // Every parent must be an authored semantic root. A name that exists only in the oracle
      // is NOT a legal parent: the authored registry composes authored objects only, so the
      // child would be silently unparented at runtime. Author the pivot explicitly instead.
      throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `authored semantic ${spec.semanticId} names parent "${parent}", which has no AuthorSpec; author the pivot as a zero-geometry group spec with its oracle-measured origin`);
    }
    if (parentSpec.parentSemanticId === spec.semanticId) throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `authored semantic cycle: ${spec.semanticId} <-> ${parent}`);
    if ((parentSpec.kind ?? "mesh-root") !== "group" && parentSpec.parts.length === 0) {
      throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `authored parent ${parent} must be a transform-only group or own geometry`);
    }
  }
  // Deterministic order: spec file order (callers sort), with children after their parents.
  const ordered: AuthorSpec[] = [];
  const visited = new Set<string>();
  const visit = (spec: AuthorSpec, chain: Set<string>): void => {
    if (visited.has(spec.semanticId)) return;
    if (chain.has(spec.semanticId)) throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `authored semantic cycle at ${spec.semanticId}`);
    chain.add(spec.semanticId);
    const parent = parentOf(spec.semanticId);
    const parentSpec = parent ? byId.get(parent) : undefined;
    if (parentSpec) visit(parentSpec, chain);
    visited.add(spec.semanticId);
    ordered.push(spec);
    chain.delete(spec.semanticId);
  };
  for (const spec of specs) visit(spec, new Set());
  // Pivot nestings: EVERY authored semantic with a parentSemanticId nests under its parent
  // group/pivot in the composition layer (world-preserving rebake), whether the parent is an
  // authored transform-only group or an external pivot semantic.
  const pivotNestings: Array<readonly [string, string]> = [];
  for (const spec of ordered) {
    const parent = spec.parentSemanticId;
    if (!parent) continue;
    pivotNestings.push([spec.semanticId, parent]);
  }
  return { ordered, pivotNestings };
}

/**
 * Reconstructs the deterministic registry ordering from the durable bindings alone: sorted
 * semantic ids, then children placed after their authored parents (the same ordering rule
 * validateAuthoredSemanticGraph applies to on-disk specs).
 */
export function orderedAuthoredSemanticsFromBindings(bindings: Record<string, AuthoredBinding>): string[] {
  const entries = Object.values(bindings).filter((binding) => binding.semanticId);
  const parents = new Map(entries.map((binding) => [binding.semanticId, binding.parentSemanticId]));
  const known = new Set(entries.map((binding) => binding.semanticId));
  const sorted = [...known].sort((a, b) => a.localeCompare(b));
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (semanticId: string, chain: Set<string>): void => {
    if (visited.has(semanticId) || !known.has(semanticId)) return;
    if (chain.has(semanticId)) return;
    chain.add(semanticId);
    const parent = parents.get(semanticId);
    if (parent && known.has(parent)) visit(parent, chain);
    visited.add(semanticId);
    ordered.push(semanticId);
    chain.delete(semanticId);
  };
  for (const semanticId of sorted) visit(semanticId, new Set());
  return ordered;
}

/** Trusted compilation of a full authored workspace: specs -> modules -> registry bytes. */
export interface AuthoredCompilation {
  specs: AuthorSpec[];
  ordered: AuthorSpec[];
  modules: Array<{ semanticId: string; path: string; source: string; manifest: AuthoredManifest; binding: AuthoredBinding }>;
  registryPath: string;
  registrySource: string;
  compiledGraphHash: string;
}

export async function compileAuthoredWorkspace(workspaceRoot: string): Promise<AuthoredCompilation> {
  const discovered = await discoverAuthorSpecs(workspaceRoot);
  if (!discovered.length) {
    throw new ConstructionRoutingError("MODE_REQUIRES_AUTHORED_SPEC", `no authored specs exist under ${AUTHOR_SPEC_DIRECTORY}/; author geometry from measurements, never from source-derived seeds`);
  }
  const specs: AuthorSpec[] = [];
  for (const entry of discovered) specs.push(await readAuthorSpec(workspaceRoot, entry.path));
  const { ordered, pivotNestings } = validateAuthoredSemanticGraph(specs);
  const modules: AuthoredCompilation["modules"] = [];
  for (const spec of ordered) {
    const compiled = compileAuthorSpec(spec);
    const source = emitAuthoredModule(compiled);
    const path = authoredModulePathOf(spec.semanticId);
    const moduleHash = sha256(Buffer.from(source, "utf8"));
    const manifest: AuthoredManifest = {
      schemaVersion: 1,
      kind: "mesh2threejs-authored-part",
      semanticId: spec.semanticId,
      parentSemanticId: spec.parentSemanticId ?? null,
      compilerVersion: AUTHORED_COMPILER_VERSION,
      authorSpecHash: compiled.specHash,
      generatedModulePath: path,
      generatedModuleHash: moduleHash,
      geometryHash: compiled.geometryHash,
      materialHash: compiled.materialHash,
      triangleCount: compiled.triangleCount,
      vertexCount: compiled.vertexCount,
      partNames: spec.parts.map((part) => part.name),
    };
    const binding: AuthoredBinding = {
      semanticId: spec.semanticId,
      authorSpecHash: compiled.specHash,
      authoredManifestHash: authoredManifestHash(manifest),
      generatedModuleHash: moduleHash,
      geometryHash: compiled.geometryHash,
      materialHash: compiled.materialHash,
      compilerVersion: manifest.compilerVersion,
      parentSemanticId: spec.parentSemanticId ?? null,
    };
    modules.push({ semanticId: spec.semanticId, path, source, manifest, binding });
  }
  const registrySource = generateAuthoredRegistrySource(ordered.map((spec) => spec.semanticId), pivotNestings);
  const compiledGraphHash = sha256(canonicalJson({
    compilerVersion: AUTHORED_COMPILER_VERSION,
    modules: modules.map((module) => ({ semanticId: module.semanticId, manifestHash: module.binding.authoredManifestHash, moduleHash: module.binding.generatedModuleHash })),
    registrySource,
  }));
  return { specs, ordered, modules, registryPath: AUTHORED_REGISTRY_PATH, registrySource, compiledGraphHash };
}

function authoredModulePathOf(semanticId: string): string {
  return `${AUTHORED_GENERATED_DIRECTORY}/${semanticId}.mjs`;
}

/**
 * Verifies authored lineage before any evaluation (mirrors verifyDerivedLineage): the entry
 * matches the stylized scaffold exactly, the registry matches trusted compile state, every
 * bound authored module passes five-way verification (manifest + binding + live bytes +
 * spec hash + compiler version), and NO executable or oracle-reaching file exists where data
 * specs are expected.
 */
export async function verifyAuthoredLineage(input: {
  modelEntryPath: string;
  workspaceRoot: string;
  constructionMode: ConstructionMode;
  authoredBindings: Record<string, AuthoredBinding>;
  expectedRegistrySource?: string;
  expectedSpecHashes?: Record<string, string>;
}): Promise<void> {
  if (effectiveConstructionMode(input.constructionMode) !== "stylized-authored") return;
  if (deriveAllowedIn(input.constructionMode)) throw new Error("verifyAuthoredLineage is stylized-only");
  const entryBytes = await readFile(input.modelEntryPath, "utf8");
  if (entryBytes !== MODEL_STYLIZED_SCAFFOLD) {
    throw new ConstructionRoutingError("MODE_FORBIDS_SOURCE_DERIVED_REPAIR", "authored lineage violation: the stylized model entry was replaced or edited; restore the pipeline-owned authored scaffold");
  }
  const registryPath = resolve(input.workspaceRoot, AUTHORED_REGISTRY_PATH);
  let registryBytes: string;
  try {
    registryBytes = await readFile(registryPath, "utf8");
  } catch {
    throw new ConstructionRoutingError("MODE_FORBIDS_SOURCE_DERIVED_REPAIR", "authored lineage violation: the authored registry is missing; run author-compile");
  }
  if (input.expectedRegistrySource && registryBytes !== input.expectedRegistrySource) {
    throw new ConstructionRoutingError("MODE_FORBIDS_SOURCE_DERIVED_REPAIR", "authored lineage violation: the authored registry does not match trusted compile state; rerun author-compile instead of editing it");
  }
  for (const [key, binding] of Object.entries(input.authoredBindings)) {
    if (!key.startsWith(`${AUTHORED_GENERATED_DIRECTORY}/`) || !key.endsWith(".mjs")) {
      throw new ConstructionRoutingError("MODE_FORBIDS_SOURCE_DERIVED_REPAIR", `authored lineage violation: binding key ${key} is not an authored module path`);
    }
    const modulePath = resolve(input.workspaceRoot, key);
    const moduleRelation = relative(resolve(input.workspaceRoot, AUTHORED_GENERATED_DIRECTORY), modulePath);
    if (moduleRelation.startsWith("..") || isAbsolute(moduleRelation)) {
      throw new ConstructionRoutingError("MODE_FORBIDS_SOURCE_DERIVED_REPAIR", `authored lineage violation: module ${key} escapes the authored generated directory`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(modulePath);
    } catch {
      throw new ConstructionRoutingError("MODE_FORBIDS_SOURCE_DERIVED_REPAIR", `authored lineage violation: bound authored module ${key} is missing`);
    }
    if (sha256(bytes) !== binding.generatedModuleHash) {
      throw new ConstructionRoutingError("MODE_FORBIDS_SOURCE_DERIVED_REPAIR", `authored lineage violation: authored module ${key} changed after compile; rerun author-compile`);
    }
    if (input.expectedSpecHashes?.[binding.semanticId] && input.expectedSpecHashes[binding.semanticId] !== binding.authorSpecHash) {
      throw new ConstructionRoutingError("AUTHORING_FROZEN", `authored spec for ${binding.semanticId} changed after the recorded compile; rerun author-compile`);
    }
  }
  await assertNoExecutableAuthoredFiles(input.workspaceRoot);
  await assertNoOracleReachingCandidateFiles(input.workspaceRoot);
}

/** `model/stylized/` holds DATA specs only; executable modules are a hard failure (design §9.4). */
export async function assertNoExecutableAuthoredFiles(workspaceRoot: string): Promise<void> {
  const directory = resolve(workspaceRoot, AUTHOR_SPEC_DIRECTORY);
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const executables = names.filter((name) => /\.(mjs|js|cjs|mts|ts)$/iu.test(name)).sort();
  if (executables.length) {
    throw new ConstructionRoutingError("ORACLE_REFERENCE_IMPORT_FORBIDDEN", `executable authored modules are not allowed: ${AUTHOR_SPEC_DIRECTORY} carries ${executables.join(", ")}; authored geometry must be declarative JSON compiled by trusted code`);
  }
}

/**
 * Backstop candidate isolation audit (design §11.3/§16.1): every candidate source file must
 * be free of imports/reads reaching the oracle, reference-view, or refs trees. The audit
 * scans import/export-from/dynamic-import specifiers and string literals that look like
 * workspace paths.
 */
export async function assertNoOracleReachingCandidateFiles(workspaceRoot: string): Promise<void> {
  const modelDirectory = resolve(workspaceRoot, "model");
  let files: string[] = [];
  try {
    const entries = await readdir(modelDirectory, { withFileTypes: true, recursive: true });
    // `parentPath` carries the nested directory for recursive scans; `name` alone does not.
    files = entries
      .filter((entry) => entry.isFile() && /\.(mjs|js|cjs|json)$/iu.test(entry.name))
      .map((entry) => join(entry.parentPath ?? modelDirectory, entry.name));
  } catch {
    return;
  }
  for (const file of files) {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const specifierPattern = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/gu;
    for (const match of source.matchAll(specifierPattern)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".") || specifier.startsWith("/") || /^[a-z]:/iu.test(specifier)) {
        const prefix = candidateImportViolation(specifier);
        if (prefix) {
          throw new ConstructionRoutingError("ORACLE_REFERENCE_IMPORT_FORBIDDEN", `candidate file ${relative(workspaceRoot, file)} imports "${specifier}", which reaches forbidden reference data (${prefix}); the oracle is a read-only reference, never candidate material`);
        }
      }
    }
  }
}

/** Loads verified authored manifests for the CURRENT state bindings (five-way authority). */
export async function loadTrustedAuthoredModules(input: {
  workspaceRoot: string;
  authoredBindings: Record<string, AuthoredBinding>;
}): Promise<Map<string, { manifestPath: string; manifestHash: string; manifest: AuthoredManifest }>> {
  const trusted = new Map<string, { manifestPath: string; manifestHash: string; manifest: AuthoredManifest }>();
  const manifestsDirectory = resolve(input.workspaceRoot, AUTHOR_MANIFEST_DIRECTORY);
  for (const [key, binding] of Object.entries(input.authoredBindings)) {
    const manifestPath = join(manifestsDirectory, `${binding.semanticId}.json`);
    let manifestValue: unknown;
    try {
      manifestValue = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!manifestValue || typeof manifestValue !== "object") continue;
    const manifest = manifestValue as AuthoredManifest;
    if (manifest.kind !== "mesh2threejs-authored-part" || manifest.semanticId !== binding.semanticId) continue;
    if (authoredManifestHash(manifest) !== binding.authoredManifestHash) continue;
    if (manifest.generatedModuleHash !== binding.generatedModuleHash) continue;
    if (manifest.authorSpecHash !== binding.authorSpecHash) continue;
    const modulePath = resolve(input.workspaceRoot, key);
    let bytes: Buffer;
    try {
      bytes = await readFile(modulePath);
    } catch {
      continue;
    }
    if (sha256(bytes) !== binding.generatedModuleHash) continue;
    trusted.set(modulePath, { manifestPath, manifestHash: binding.authoredManifestHash, manifest });
  }
  return trusted;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export { compileAuthorSpec, emitAuthoredModule, generateAuthoredRegistrySource, validateAuthorSpec, type AuthorSpec };
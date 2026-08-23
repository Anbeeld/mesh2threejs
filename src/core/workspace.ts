import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { AuthorshipMode, CertificationLevel, ProfileId } from "../types.js";
import { determineNextAction, loadTaskState, saveTaskState, createTaskState, type TaskState } from "./state.js";
import { canonicalJson, sha256 } from "./hashing.js";
import { validateOracleManifest, validateProjectManifest, validateReferenceIndex } from "./schema.js";
import { emptyGeneratedRegistry } from "./derivation.js";
import { verifyOraclePreparation, type OracleManifest, type OraclePreparationBinding } from "./oracle.js";
import { loadStyleContract, type StyleContract } from "../styles/low-poly.js";
import { getProfileContract, profileContractHash } from "./contracts.js";
import { inspectCandidateIdentity, type CandidateIdentity } from "./candidate.js";
import { neutralPoseForProfile } from "./orchestration.js";
import type { GenericSubjectContract } from "../profiles/generic.js";
import { optionalContractHash } from "./identity.js";

export type ReferenceMode = "copy" | "external";
export type ReferenceKind = "oracle" | "image" | "document";

export interface ProjectManifest {
  schemaVersion: 1;
  id: string;
  goal: string;
  profile: ProfileId;
  style: string;
  oracle: string | null;
  images: string[];
  documents: string[];
  model: string;
  certification: CertificationLevel;
  referenceMode: ReferenceMode;
  portable: boolean;
  subjectContract?: string;
  /** Build-time authorship strategy; absent on legacy projects, which behave as "independent". */
  authorshipMode?: AuthorshipMode;
}

export interface ReferenceRecord {
  kind: ReferenceKind;
  mode: ReferenceMode;
  operationalPath: string;
  originalPath: string;
  sha256: string;
}

export interface ReferenceIndex {
  schemaVersion: 1;
  records: ReferenceRecord[];
}

export interface ProjectConfigurationIdentity {
  schemaVersion: 1;
  profile: ProfileId;
  style: string;
  certification: CertificationLevel;
  model: string;
  oracle: { path: string; sha256: string; mode: ReferenceMode } | null;
  subjectContract: { path: string; sha256: string; mode: ReferenceMode } | null;
}

export function projectConfigurationIdentity(project: ProjectManifest, references: ReferenceIndex): ProjectConfigurationIdentity {
  const selected = (path: string | null | undefined, kind: ReferenceKind): { path: string; sha256: string; mode: ReferenceMode } | null => {
    if (!path) return null;
    const record = references.records.find((item) => item.kind === kind && item.operationalPath === path);
    if (!record) throw new Error(`project ${kind} selection is absent from the reference index: ${path}`);
    return { path: record.operationalPath, sha256: record.sha256, mode: record.mode };
  };
  return {
    schemaVersion: 1,
    profile: project.profile,
    style: project.style,
    certification: project.certification,
    model: project.model,
    oracle: selected(project.oracle, "oracle"),
    subjectContract: selected(project.subjectContract, "document"),
  };
}

export function projectConfigurationHash(project: ProjectManifest, references: ReferenceIndex): string {
  return sha256(canonicalJson(projectConfigurationIdentity(project, references)));
}

export interface InitializeWorkspaceInput {
  id: string;
  goal: string;
  profile: ProfileId;
  style?: string;
  certification?: CertificationLevel;
  references?: string[];
  oracle?: string;
  images?: string[];
  documents?: string[];
  referenceMode?: ReferenceMode;
  model?: string;
  subjectContract?: string;
  authorshipMode?: AuthorshipMode;
}

export interface WorkspaceLayout {
  root: string;
  project: string;
  refs: { root: string; oracle: string; images: string; docs: string };
  model: string;
  internal: {
    root: string;
    state: string;
    references: string;
    oracle: string;
    oracleManifest: string;
    preparedOracle: string;
    oracleCache: string;
    evidence: string;
    reports: string;
    captures: string;
    visualReview: string;
    locks: string;
  };
}

export interface WorkspaceResolver {
  layout: WorkspaceLayout;
  resolveProjectPath: (path: string) => string;
  toProjectPath: (path: string) => string;
  resolveReferencePath: (path: string, mode: ReferenceMode) => string;
}

const ORACLE_EXTENSIONS = new Set([".glb"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".bmp"]);
const DOCUMENT_EXTENSIONS = new Set([".md", ".txt", ".json", ".pdf", ".csv", ".tsv"]);

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function portablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function assertInside(root: string, target: string, label: string): void {
  const relation = relative(root, target);
  if (!relation || (!relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && relation !== ".." && !isAbsolute(relation))) return;
  throw new Error(`${label} escapes workspace root`);
}

export function createWorkspaceResolver(workspaceRoot: string): WorkspaceResolver {
  const root = resolve(workspaceRoot);
  const internalRoot = join(root, ".mesh2threejs");
  const layout: WorkspaceLayout = {
    root,
    project: join(root, "project.json"),
    refs: { root: join(root, "refs"), oracle: join(root, "refs", "oracle"), images: join(root, "refs", "images"), docs: join(root, "refs", "docs") },
    model: join(root, "model"),
    internal: {
      root: internalRoot,
      state: join(internalRoot, "state.json"),
      references: join(internalRoot, "references.json"),
      oracle: join(internalRoot, "oracle"),
      oracleManifest: join(internalRoot, "oracle", "manifest.json"),
      preparedOracle: join(internalRoot, "oracle", "prepared.json"),
      oracleCache: join(internalRoot, "oracle", "cache"),
      evidence: join(internalRoot, "evidence"),
      reports: join(internalRoot, "reports"),
      captures: join(internalRoot, "captures"),
      visualReview: join(internalRoot, "visual-review"),
      locks: join(internalRoot, "locks"),
    },
  };
  const resolveProjectPath = (path: string): string => {
    if (!path.trim() || isAbsolute(path)) throw new Error(`project path must be workspace-relative: ${path}`);
    const target = resolve(root, path);
    assertInside(root, target, `project path ${path}`);
    return target;
  };
  const toProjectPath = (path: string): string => {
    const target = resolve(path);
    assertInside(root, target, `path ${path}`);
    return portablePath(relative(root, target));
  };
  return {
    layout,
    resolveProjectPath,
    toProjectPath,
    resolveReferencePath: (path, mode) => mode === "external"
      ? (isAbsolute(path) ? resolve(path) : (() => { throw new Error(`external reference path must be absolute: ${path}`); })())
      : resolveProjectPath(path),
  };
}

export function classifyReference(path: string): ReferenceKind {
  const extension = extname(path).toLowerCase();
  if (ORACLE_EXTENSIONS.has(extension)) return "oracle";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  throw new Error(`reference type is unsupported or ambiguous: ${path}`);
}

function referenceDirectory(layout: WorkspaceLayout, kind: ReferenceKind): string {
  return kind === "oracle" ? layout.refs.oracle : kind === "image" ? layout.refs.images : layout.refs.docs;
}

async function listFiles(path: string): Promise<string[]> {
  if (!await pathExists(path)) return [];
  return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(path, entry.name)).sort();
}

async function readProject(path: string): Promise<ProjectManifest> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  const validation = validateProjectManifest(value);
  if (!validation.valid) throw new Error(`project.json schema is invalid: ${JSON.stringify(validation.errors)}`);
  return value as ProjectManifest;
}

async function referenceBytes(path: string): Promise<{ bytes: Buffer; hash: string }> {
  let info;
  try { info = await stat(path); } catch { throw new Error(`reference file is missing: ${path}`); }
  if (!info.isFile()) throw new Error(`reference path is not a file: ${path}`);
  const bytes = await readFile(path);
  return { bytes, hash: sha256(bytes) };
}

interface PlannedReference extends ReferenceRecord { source: string; destination?: string; }

async function planCopiedReference(
  resolver: WorkspaceResolver,
  source: string,
  kind: ReferenceKind,
  hash: string,
  planned: Map<string, string>,
): Promise<PlannedReference> {
  const absolute = resolve(source);
  const targetDirectory = referenceDirectory(resolver.layout, kind);
  const sourceRelation = relative(targetDirectory, absolute);
  if (sourceRelation && sourceRelation !== ".." && !sourceRelation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(sourceRelation)) {
    const operationalPath = resolver.toProjectPath(absolute);
    planned.set(absolute.toLowerCase(), hash);
    return { kind, mode: "copy", operationalPath, originalPath: absolute, sha256: hash, source: absolute };
  }
  const parsed = parse(basename(absolute));
  let destination = join(targetDirectory, basename(absolute));
  const matches = async (path: string): Promise<boolean> => {
    const pending = planned.get(path.toLowerCase());
    if (pending) return pending === hash;
    if (!await pathExists(path)) return false;
    return sha256(await readFile(path)) === hash;
  };
  if (planned.has(destination.toLowerCase()) || await pathExists(destination)) {
    if (await matches(destination)) return { kind, mode: "copy", operationalPath: resolver.toProjectPath(destination), originalPath: absolute, sha256: hash, source: absolute };
    destination = join(targetDirectory, `${parsed.name}-${hash.slice(0, 8)}${parsed.ext}`);
    if ((planned.has(destination.toLowerCase()) || await pathExists(destination)) && !await matches(destination)) {
      destination = join(targetDirectory, `${parsed.name}-${hash}${parsed.ext}`);
      if ((planned.has(destination.toLowerCase()) || await pathExists(destination)) && !await matches(destination)) throw new Error(`reference collision cannot be resolved safely: ${basename(absolute)}`);
    }
  }
  planned.set(destination.toLowerCase(), hash);
  return { kind, mode: "copy", operationalPath: resolver.toProjectPath(destination), originalPath: absolute, sha256: hash, source: absolute, destination };
}

export const MODEL_SCAFFOLD = `import * as THREE from "three";

export function createCandidate() {
  return new THREE.Group();
}
`;

/**
 * Stable authored entry for DERIVED-mode projects: it never changes after initialization.
 * The pipeline composes phases by regenerating `.generated/registry.mjs`, which this entry
 * imports exactly once, so later derivations stay automatic without touching agent files.
 */
export const MODEL_DERIVED_SCAFFOLD = `import { createGeneratedCandidate } from "./.generated/registry.mjs";

export function createCandidate() {
  return createGeneratedCandidate();
}
`;

export async function initializeWorkspace(directory: string, input: InitializeWorkspaceInput): Promise<{ root: string; layout: WorkspaceLayout; project: ProjectManifest; references: ReferenceIndex; directories: string[] }> {
  const resolver = createWorkspaceResolver(directory);
  const { layout } = resolver;
  if (await pathExists(layout.project)) throw new Error(`workspace is already initialized: ${layout.project}`);
  const mode = input.referenceMode ?? "copy";
  const model = portablePath(input.model ?? "model/model.mjs");
  const modelPath = resolver.resolveProjectPath(model);
  if (!model.startsWith("model/")) throw new Error("authored model path must be under model/");
  const explicit: Array<{ path: string; kind: ReferenceKind; mode: ReferenceMode }> = [
    ...(input.oracle ? [{ path: input.oracle, kind: "oracle" as const, mode }] : []),
    ...(input.images ?? []).map((path) => ({ path, kind: "image" as const, mode })),
    ...(input.documents ?? []).map((path) => ({ path, kind: "document" as const, mode })),
    ...(input.subjectContract && ![...(input.documents ?? []), ...(input.references ?? [])].some((path) => resolve(path) === resolve(input.subjectContract!))
      ? [{ path: input.subjectContract, kind: "document" as const, mode }]
      : []),
    ...(input.references ?? []).map((path) => ({ path, kind: classifyReference(path), mode })),
  ];
  if (explicit.filter((item) => item.kind === "oracle").length > 1 && !input.oracle) throw new Error("multiple oracle references require one explicit --oracle selection");
  for (const item of explicit) {
    if (item.kind === "oracle" && classifyReference(item.path) !== "oracle") throw new Error(`oracle reference must be a supported 3D model: ${item.path}`);
    await referenceBytes(resolve(item.path));
  }

  await mkdir(layout.root, { recursive: true });
  await Promise.all([layout.refs.oracle, layout.refs.images, layout.refs.docs].map((path) => mkdir(path, { recursive: true })));
  const existingByKind: Record<ReferenceKind, string[]> = {
    oracle: (await listFiles(layout.refs.oracle)).filter((path) => ORACLE_EXTENSIONS.has(extname(path).toLowerCase())),
    image: (await listFiles(layout.refs.images)).filter((path) => IMAGE_EXTENSIONS.has(extname(path).toLowerCase())),
    document: (await listFiles(layout.refs.docs)).filter((path) => DOCUMENT_EXTENSIONS.has(extname(path).toLowerCase())),
  };
  if (!explicit.some((item) => item.kind === "oracle") && existingByKind.oracle.length > 1) throw new Error("multiple oracle files found under refs/oracle; select one explicitly");

  const planned = new Map<string, string>();
  const records: PlannedReference[] = [];
  for (const kind of ["oracle", "image", "document"] as const) {
    for (const path of existingByKind[kind]) {
      const { hash } = await referenceBytes(path);
      planned.set(path.toLowerCase(), hash);
      records.push({ kind, mode: "copy", operationalPath: resolver.toProjectPath(path), originalPath: resolve(path), sha256: hash, source: path });
    }
  }
  for (const item of explicit) {
    const absolute = resolve(item.path);
    const { hash } = await referenceBytes(absolute);
    records.push(item.mode === "external"
      ? { kind: item.kind, mode: "external", operationalPath: absolute, originalPath: absolute, sha256: hash, source: absolute }
      : await planCopiedReference(resolver, absolute, item.kind, hash, planned));
  }
  const oracleRecords = records.filter((record) => record.kind === "oracle");
  const selectedOracle = explicit.find((item) => item.kind === "oracle");
  const oracleRecord = selectedOracle
    ? [...records].reverse().find((record) => record.kind === "oracle" && record.originalPath === resolve(selectedOracle.path))
    : oracleRecords[0];
  const uniquePaths = (kind: ReferenceKind): string[] => [...new Set(records.filter((record) => record.kind === kind).map((record) => record.operationalPath))];
  const subjectContractRecord = input.subjectContract
    ? [...records].reverse().find((record) => record.kind === "document" && record.originalPath === resolve(input.subjectContract!))
    : undefined;
  // New 3D-oracle workspaces default to derived authorship; an explicit clean-room project
  // declares "independent". Projects without a 3D oracle stay independent.
  const authorshipMode: AuthorshipMode = input.authorshipMode ?? (oracleRecord ? "derived" : "independent");
  const project: ProjectManifest = {
    schemaVersion: 1,
    id: input.id,
    goal: input.goal,
    profile: input.profile,
    style: input.style ?? "low-poly-faithful",
    oracle: oracleRecord?.operationalPath ?? null,
    images: uniquePaths("image"),
    documents: uniquePaths("document"),
    model,
    certification: input.certification ?? "oracle-relative",
    referenceMode: mode,
    portable: records.every((record) => record.mode === "copy"),
    authorshipMode,
    ...(subjectContractRecord ? { subjectContract: subjectContractRecord.operationalPath } : {}),
  };
  const referenceIndex: ReferenceIndex = { schemaVersion: 1, records: records.map(({ source: _source, destination: _destination, ...record }) => record) };
  const style = await loadStyleContract(project.style);
  const configurationHash = projectConfigurationHash(project, referenceIndex);
  const subjectContractValue = subjectContractRecord ? JSON.parse(await readFile(subjectContractRecord.source, "utf8")) as GenericSubjectContract : undefined;
  const subjectContractHash = optionalContractHash(subjectContractValue);
  const articulationRequired = getProfileContract(project.profile).articulation.length > 0 || Boolean(subjectContractValue?.articulation?.length);
  const directories = ["refs/oracle", "refs/images", "refs/docs", "model", ".mesh2threejs/oracle/cache", ".mesh2threejs/evidence", ".mesh2threejs/reports", ".mesh2threejs/captures", ".mesh2threejs/visual-review", ".mesh2threejs/locks"];
  const created: string[] = [];
  try {
    await Promise.all(directories.map((path) => mkdir(resolver.resolveProjectPath(path), { recursive: true })));
    for (const [index, record] of records.entries()) {
      if (!record.destination || await pathExists(record.destination)) continue;
      const temporary = `${record.destination}.${process.pid}.${index}.tmp`;
      await copyFile(record.source, temporary, constants.COPYFILE_EXCL);
      if (sha256(await readFile(temporary)) !== record.sha256) { await rm(temporary, { force: true }); throw new Error(`imported reference hash mismatch: ${record.source}`); }
      await rename(temporary, record.destination);
      created.push(record.destination);
    }
    if (!await pathExists(modelPath)) {
      await mkdir(dirname(modelPath), { recursive: true });
      // Derived projects get the stable registry-composed entry immediately so every later
      // derivation stays pipeline-wired; independent/legacy projects keep the plain scaffold.
      await writeFile(modelPath, project.authorshipMode === "derived" ? MODEL_DERIVED_SCAFFOLD : MODEL_SCAFFOLD, { flag: "wx" });
      created.push(modelPath);
    }
    if (project.authorshipMode === "derived") {
      const generatedDirectory = resolver.resolveProjectPath("model/.generated");
      await mkdir(generatedDirectory, { recursive: true });
      const registryPath = join(generatedDirectory, "registry.mjs");
      if (!await pathExists(registryPath)) { await writeFile(registryPath, emptyGeneratedRegistry(project.profile)); created.push(registryPath); }
    }
    await writeFile(layout.internal.references, `${JSON.stringify(referenceIndex, null, 2)}\n`, { flag: "wx" }); created.push(layout.internal.references);
    await saveTaskState(layout.internal.state, createTaskState({ taskId: project.id, profile: project.profile, style: project.style, certification: project.certification, styleContractHash: style.hash, projectConfigurationHash: configurationHash, subjectContractHash, articulationRequired, ...(project.authorshipMode ? { authorshipMode: project.authorshipMode } : {}) })); created.push(layout.internal.state);
    await writeFile(layout.project, `${JSON.stringify(project, null, 2)}\n`, { flag: "wx" }); created.push(layout.project);
  } catch (error) {
    for (const path of created.reverse()) await rm(path, { force: true });
    throw error;
  }
  return { root: layout.root, layout, project, references: referenceIndex, directories };
}

export async function locateWorkspaceRoot(input: string): Promise<string> {
  const absolute = resolve(input);
  let info;
  try { info = await stat(absolute); } catch { throw new Error(`workspace path does not exist: ${absolute}`); }
  if (info.isDirectory()) return absolute;
  if (basename(absolute) === "project.json") return dirname(absolute);
  if (basename(absolute) === "state.json" && basename(dirname(absolute)) === ".mesh2threejs") return dirname(dirname(absolute));
  throw new Error(`path is not a workspace root, project.json, or canonical state file: ${absolute}`);
}

export async function resolveStateTarget(input: string): Promise<{ statePath: string; workspaceRoot?: string }> {
  const absolute = resolve(input);
  try {
    const root = await locateWorkspaceRoot(absolute);
    return { statePath: createWorkspaceResolver(root).layout.internal.state, workspaceRoot: root };
  } catch {
    if (basename(absolute) === "state.json" && await pathExists(absolute)) return { statePath: absolute };
    throw new Error(`state or workspace path does not exist: ${absolute}`);
  }
}

export interface ResumedWorkspace {
  root: string;
  layout: WorkspaceLayout;
  project: ProjectManifest;
  references: ReferenceIndex;
  state: TaskState;
  styleContract: StyleContract;
  styleContractHash: string;
  resolved: { oracle: string | null; model: string; images: string[]; documents: string[]; subjectContract?: string };
  nextAction: ReturnType<typeof determineNextAction>;
}

export interface WorkspaceOraclePreparation {
  manifest: OracleManifest;
  binding: OraclePreparationBinding;
  reference: ReferenceRecord;
}

/**
 * Fails closed unless the onboarded preparation on disk is (1) intact end to end, (2) prepared from
 * the oracle reference the project currently selects, and (3) identical to the preparation the
 * durable state and evidence chain were gated against. Every workspace authority boundary runs
 * this one check instead of partial per-command comparisons.
 */
export async function verifyWorkspaceOraclePreparation(workspace: ResumedWorkspace): Promise<WorkspaceOraclePreparation> {
  if (!workspace.project.oracle) throw new Error("workspace has no selected oracle reference; configure project.json before onboarding");
  const record = workspace.references.records.find((item) => item.kind === "oracle" && item.operationalPath === workspace.project.oracle);
  if (!record) throw new Error("workspace oracle is absent from the reference index");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(await readFile(workspace.layout.internal.oracleManifest, "utf8"));
  } catch {
    throw new Error("no onboarded oracle preparation exists in this workspace; run onboard first");
  }
  if (!validateOracleManifest(manifestValue).valid) throw new Error("oracle manifest schema is invalid");
  const manifest = manifestValue as OracleManifest;
  if (manifest.sourcePath !== record.operationalPath || manifest.sourceHash !== record.sha256) {
    throw new Error("the onboarded preparation contradicts the selected oracle reference; run onboard for the current reference");
  }
  const binding = await verifyOraclePreparation(manifest, workspace.root);
  const bound = workspace.state.oraclePreparation;
  if (!bound) throw new Error("no oracle preparation is bound to workspace state; run onboard");
  if (bound.identity !== binding.identity || bound.sourceHash !== binding.sourceHash || bound.preparedHash !== binding.preparedHash) {
    throw new Error("the live oracle preparation differs from the state-bound preparation; rerun onboard/repair and rebuild the evidence chain");
  }
  return { manifest, binding, reference: record };
}

/** Archives the active preparation so a subsequent rebind cannot silently reuse it. Returns the archive directory or null when nothing was onboarded. */
export async function archiveWorkspacePreparation(root: string): Promise<string | null> {
  const resolver = createWorkspaceResolver(root);
  const oracleDirectory = resolver.layout.internal.oracle;
  let names: string[];
  try {
    names = (await readdir(oracleDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && (entry.name === "manifest.json" || entry.name.startsWith("prepared"))).map((entry) => entry.name);
  } catch {
    return null;
  }
  if (!names.length) return null;
  const archiveRoot = join(oracleDirectory, "archive");
  const existing = await pathExists(archiveRoot) ? (await readdir(archiveRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  let sequence = 1;
  for (const name of existing) {
    const match = /^preparation-(\d+)$/u.exec(name);
    if (match) sequence = Math.max(sequence, Number(match[1]) + 1);
  }
  const archive = join(archiveRoot, `preparation-${String(sequence).padStart(4, "0")}`);
  await mkdir(archive, { recursive: true });
  for (const name of names.sort()) await rename(join(oracleDirectory, name), join(archive, name));
  return archive;
}

export async function resumeWorkspace(input: string): Promise<ResumedWorkspace> {
  const root = await locateWorkspaceRoot(input);
  const resolver = createWorkspaceResolver(root);
  const project = await readProject(resolver.layout.project);
  resolver.resolveProjectPath(project.model);
  const referenceValue: unknown = JSON.parse(await readFile(resolver.layout.internal.references, "utf8"));
  const referenceValidation = validateReferenceIndex(referenceValue);
  if (!referenceValidation.valid) throw new Error(`reference index is invalid: ${JSON.stringify(referenceValidation.errors)}`);
  const referenceIndex = referenceValue as ReferenceIndex;
  if (project.portable !== referenceIndex.records.every((record) => record.mode === "copy")) throw new Error("project portability contradicts the reference index");
  for (const record of referenceIndex.records) {
    const path = resolver.resolveReferencePath(record.operationalPath, record.mode);
    if (!await pathExists(path)) throw new Error(`missing reference: ${record.operationalPath}`);
    if (sha256(await readFile(path)) !== record.sha256) throw new Error(`reference hash changed: ${record.operationalPath}`);
  }
  const resolveListed = (paths: string[], kind: ReferenceKind): string[] => paths.map((path) => {
    const record = referenceIndex.records.find((item) => item.operationalPath === path && item.kind === kind);
    if (!record) throw new Error(`project reference is absent from the reference index: ${path}`);
    return resolver.resolveReferencePath(path, record.mode);
  });
  const oracle = project.oracle ? resolveListed([project.oracle], "oracle")[0]! : null;
  const model = resolver.resolveProjectPath(project.model);
  if (!await pathExists(model)) throw new Error(`authored model is missing: ${project.model}`);
  const state = await loadTaskState(resolver.layout.internal.state);
  const subjectContract = project.subjectContract ? resolveListed([project.subjectContract], "document")[0] : undefined;
  const subjectContractValue = subjectContract ? JSON.parse(await readFile(subjectContract, "utf8")) as GenericSubjectContract : undefined;
  const subjectContractHash = optionalContractHash(subjectContractValue);
  const style = await loadStyleContract(project.style);
  const currentProjectHash = projectConfigurationHash(project, referenceIndex);
  if (!state.projectConfigurationHash) throw new Error("workspace state has no bound project configuration; run an explicit migration or rebind");
  if (state.projectConfigurationHash !== currentProjectHash || state.profile !== project.profile || state.style !== project.style || state.certification !== project.certification) throw new Error("project configuration differs from state; run an explicit migration or rebind");
  if (state.authorshipMode !== (project.authorshipMode ?? "independent")) throw new Error("project authorship mode differs from state; run an explicit rebind to change the authorship strategy");
  if (state.profileContractHash !== profileContractHash(getProfileContract(project.profile))) throw new Error("profile contract differs from state; rebind before continuing");
  if (state.styleContractHash !== style.hash) throw new Error("style contract differs from state; rebind before continuing");
  if (state.subjectContractHash !== subjectContractHash || state.articulationRequired !== (getProfileContract(project.profile).articulation.length > 0 || Boolean(subjectContractValue?.articulation?.length))) throw new Error("subject articulation contract differs from state; rebind before continuing");
  return { root, layout: resolver.layout, project, references: referenceIndex, state, styleContract: style.contract, styleContractHash: style.hash, resolved: { oracle, model, images: resolveListed(project.images, "image"), documents: resolveListed(project.documents, "document"), ...(subjectContract ? { subjectContract } : {}) }, nextAction: determineNextAction(state) };
}

export async function verifyWorkspaceCandidateIdentity(workspace: ResumedWorkspace, auditOptions?: import("./candidate.js").CandidateAuditOptions): Promise<CandidateIdentity> {
  const subjectContract = workspace.resolved.subjectContract
    ? JSON.parse(await readFile(workspace.resolved.subjectContract, "utf8")) as GenericSubjectContract
    : undefined;
  return inspectCandidateIdentity(workspace.resolved.model, neutralPoseForProfile(workspace.project.profile, subjectContract), auditOptions);
}

/** Explicitly starts a new evidence chain for the current project and reference bytes. */
export async function rebindWorkspace(input: string): Promise<ResumedWorkspace> {
  const root = await locateWorkspaceRoot(input);
  const resolver = createWorkspaceResolver(root);
  const project = await readProject(resolver.layout.project);
  const referenceValue: unknown = JSON.parse(await readFile(resolver.layout.internal.references, "utf8"));
  const validation = validateReferenceIndex(referenceValue);
  if (!validation.valid) throw new Error(`reference index is invalid: ${JSON.stringify(validation.errors)}`);
  const references = referenceValue as ReferenceIndex;
  const reboundReferences: ReferenceIndex = {
    schemaVersion: 1,
    records: await Promise.all(references.records.map(async (record) => {
      const path = resolver.resolveReferencePath(record.operationalPath, record.mode);
      if (!await pathExists(path)) throw new Error(`missing reference: ${record.operationalPath}`);
      return { ...record, sha256: sha256(await readFile(path)) };
    })),
  };
  const style = await loadStyleContract(project.style);
  const subjectRecord = project.subjectContract
    ? reboundReferences.records.find((record) => record.kind === "document" && record.operationalPath === project.subjectContract)
    : undefined;
  if (project.subjectContract && !subjectRecord) throw new Error(`project subject contract is absent from the reference index: ${project.subjectContract}`);
  const subjectPath = subjectRecord ? resolver.resolveReferencePath(subjectRecord.operationalPath, subjectRecord.mode) : undefined;
  const subjectContract = subjectPath ? JSON.parse(await readFile(subjectPath, "utf8")) as GenericSubjectContract : undefined;
  const next = createTaskState({
    taskId: project.id,
    profile: project.profile,
    style: project.style,
    certification: project.certification,
    styleContractHash: style.hash,
    projectConfigurationHash: projectConfigurationHash(project, reboundReferences),
    subjectContractHash: optionalContractHash(subjectContract),
    articulationRequired: getProfileContract(project.profile).articulation.length > 0 || Boolean(subjectContract?.articulation?.length),
    ...(project.authorshipMode ? { authorshipMode: project.authorshipMode } : {}),
  });
  next.systemDecisions.push({ id: "workspace-rebind", value: next.projectConfigurationHash, reason: "explicit rebind started a new evidence chain for current project configuration and reference bytes" });
  const archivedPreparation = await archiveWorkspacePreparation(root);
  if (archivedPreparation) next.systemDecisions.push({ id: "oracle-preparation-archived", value: archivedPreparation, reason: "rebind archived the previous active preparation so it cannot be silently consumed by the new evidence chain" });
  const referencesTemporary = `${resolver.layout.internal.references}.${process.pid}.tmp`;
  await writeFile(referencesTemporary, `${JSON.stringify(reboundReferences, null, 2)}\n`, { flag: "wx" });
  await rename(referencesTemporary, resolver.layout.internal.references);
  await saveTaskState(resolver.layout.internal.state, next);
  return resumeWorkspace(root);
}

interface LegacyTaskManifest {
  schemaVersion: 1;
  id: string;
  goal: string;
  profile: ProfileId;
  style: string;
  oracleManifest: string;
  candidateModule: string;
  certification: CertificationLevel;
  subjectContract?: string;
}

function rebaseEvidencePath(path: string, root: string, resolver: WorkspaceResolver): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const legacyEvidence = join(root, "evidence");
  const relation = relative(legacyEvidence, absolute);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) return resolver.toProjectPath(join(resolver.layout.internal.evidence, relation));
  return path;
}

export async function migrateWorkspace(directory: string, options: { oracle?: string; referenceMode?: ReferenceMode } = {}): Promise<{ root: string; layout: WorkspaceLayout; project: ProjectManifest; references: ReferenceIndex }> {
  const root = resolve(directory);
  const legacyTaskPath = join(root, "task.json");
  const legacyStatePath = join(root, "state.json");
  if (!await pathExists(legacyTaskPath) || !await pathExists(legacyStatePath)) throw new Error("legacy migration requires task.json and state.json");
  const task = JSON.parse(await readFile(legacyTaskPath, "utf8")) as LegacyTaskManifest;
  const legacyState = await loadTaskState(legacyStatePath);
  const legacyModel = createWorkspaceResolver(root).resolveProjectPath(task.candidateModule);
  if (!await pathExists(legacyModel)) throw new Error(`legacy candidate module is missing: ${task.candidateModule}`);
  let oracle = options.oracle;
  if (!oracle) {
    const legacyManifestPath = createWorkspaceResolver(root).resolveProjectPath(task.oracleManifest);
    if (!await pathExists(legacyManifestPath)) throw new Error("legacy oracle manifest is missing; provide --oracle explicitly");
    const legacyManifest = JSON.parse(await readFile(legacyManifestPath, "utf8")) as { sourcePath?: unknown };
    if (typeof legacyManifest.sourcePath !== "string") throw new Error("legacy oracle manifest lacks sourcePath; provide --oracle explicitly");
    oracle = isAbsolute(legacyManifest.sourcePath) ? legacyManifest.sourcePath : resolve(dirname(legacyManifestPath), legacyManifest.sourcePath);
  }
  await referenceBytes(resolve(oracle));
  const resolver = createWorkspaceResolver(root);
  const model = portablePath(join("model", basename(legacyModel)));
  await cp(dirname(legacyModel), resolver.layout.model, { recursive: true, errorOnExist: true });
  let initialized;
  try {
    initialized = await initializeWorkspace(root, {
      id: task.id, goal: task.goal, profile: task.profile, style: task.style, certification: task.certification,
      oracle, referenceMode: options.referenceMode ?? "copy", model,
      ...(task.subjectContract ? { subjectContract: resolver.resolveProjectPath(task.subjectContract) } : {}),
    });
  } catch (error) {
    await rm(resolver.layout.model, { recursive: true, force: true });
    throw error;
  }
  // Migrated legacy workspaces keep clean-room behavior: their project and durable state use
  // independent authorship regardless of the oracle-present default for new workspaces.
  initialized.project.authorshipMode = "independent";
  const migratedConfigurationHash = projectConfigurationHash(initialized.project, initialized.references);
  await writeFile(initialized.layout.project, `${JSON.stringify(initialized.project, null, 2)}\n`);
  for (const evidence of Object.values(legacyState.evidence)) evidence.artifact = rebaseEvidencePath(evidence.artifact, root, resolver);
  for (const lock of Object.values(legacyState.locks)) for (const evidence of lock.evidence) evidence.artifact = rebaseEvidencePath(evidence.artifact, root, resolver);
  legacyState.oracleHash = null;
  legacyState.oraclePreparation = null;
  legacyState.status = "active";
  legacyState.route = "onboard-oracle";
  legacyState.activePhase = "oracle-registration";
  for (const phase of Object.keys(legacyState.phaseStatus)) legacyState.phaseStatus[phase] = phase === "oracle-registration" ? "active" : "pending";
  for (const evidence of Object.values(legacyState.evidence)) { evidence.valid = false; evidence.verified = false; }
  legacyState.locks = {};
  legacyState.phaseGeometryHashes = {};
  legacyState.evidenceConfigHashes = {};
  legacyState.visualReviewStatus = "awaiting";
  const initializedState = await loadTaskState(resolver.layout.internal.state);
  legacyState.profile = initializedState.profile;
  legacyState.style = initializedState.style;
  legacyState.certification = initializedState.certification;
  legacyState.profileContractHash = initializedState.profileContractHash;
  legacyState.styleContractHash = initializedState.styleContractHash;
  legacyState.projectConfigurationHash = migratedConfigurationHash;
  legacyState.systemDecisions.push({ id: "workspace-layout-migration", value: "oracle-revalidation-required", reason: "reference paths changed during migration; historical evidence was retained but invalidated" });
  await saveTaskState(resolver.layout.internal.state, legacyState);
  for (const name of ["evidence", "reports", "captures", "visual-review"] as const) {
    const source = join(root, name);
    const destination = resolver.layout.internal[name === "visual-review" ? "visualReview" : name];
    if (await pathExists(source)) await cp(source, destination, { recursive: true, force: false, errorOnExist: false });
  }
  const legacyArchive = join(resolver.layout.internal.root, "legacy");
  await mkdir(legacyArchive, { recursive: true });
  for (const name of ["task.json", "state.json", "candidate", "oracle", "evidence", "reports", "captures", "visual-review"]) {
    const source = join(root, name);
    if (await pathExists(source)) await rename(source, join(legacyArchive, name));
  }
  return { root, layout: initialized.layout, project: initialized.project, references: initialized.references };
}

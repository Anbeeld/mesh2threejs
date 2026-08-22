import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { CertificationLevel, ProfileId } from "../types.js";
import { determineNextAction, loadTaskState, saveTaskState, createTaskState, type TaskState } from "./state.js";
import { sha256 } from "./hashing.js";
import { validateProjectManifest, validateReferenceIndex } from "./schema.js";

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

const MODEL_SCAFFOLD = `import * as THREE from "three";

export function createCandidate() {
  return new THREE.Group();
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
    ...(subjectContractRecord ? { subjectContract: subjectContractRecord.operationalPath } : {}),
  };
  const referenceIndex: ReferenceIndex = { schemaVersion: 1, records: records.map(({ source: _source, destination: _destination, ...record }) => record) };
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
    if (!await pathExists(modelPath)) { await mkdir(dirname(modelPath), { recursive: true }); await writeFile(modelPath, MODEL_SCAFFOLD, { flag: "wx" }); created.push(modelPath); }
    await writeFile(layout.internal.references, `${JSON.stringify(referenceIndex, null, 2)}\n`, { flag: "wx" }); created.push(layout.internal.references);
    await saveTaskState(layout.internal.state, createTaskState({ taskId: project.id, profile: project.profile, style: project.style, certification: project.certification })); created.push(layout.internal.state);
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

export async function resumeWorkspace(input: string): Promise<{ root: string; layout: WorkspaceLayout; project: ProjectManifest; references: ReferenceIndex; state: TaskState; resolved: { oracle: string | null; model: string; images: string[]; documents: string[]; subjectContract?: string }; nextAction: ReturnType<typeof determineNextAction> }> {
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
  return { root, layout: resolver.layout, project, references: referenceIndex, state, resolved: { oracle, model, images: resolveListed(project.images, "image"), documents: resolveListed(project.documents, "document"), ...(subjectContract ? { subjectContract } : {}) }, nextAction: determineNextAction(state) };
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
  for (const evidence of Object.values(legacyState.evidence)) evidence.artifact = rebaseEvidencePath(evidence.artifact, root, resolver);
  for (const lock of Object.values(legacyState.locks)) for (const evidence of lock.evidence) evidence.artifact = rebaseEvidencePath(evidence.artifact, root, resolver);
  legacyState.oracleHash = null;
  legacyState.status = "active";
  legacyState.route = "onboard-oracle";
  legacyState.activePhase = "oracle-registration";
  for (const phase of Object.keys(legacyState.phaseStatus)) legacyState.phaseStatus[phase] = phase === "oracle-registration" ? "active" : "pending";
  for (const evidence of Object.values(legacyState.evidence)) { evidence.valid = false; evidence.verified = false; }
  legacyState.locks = {};
  legacyState.phaseGeometryHashes = {};
  legacyState.evidenceConfigHashes = {};
  legacyState.visualReviewStatus = "awaiting";
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

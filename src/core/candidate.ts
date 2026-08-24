import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as THREE from "three";
import type { CandidateModule, CandidateRuntime } from "../types.js";
import { canonicalJson, fingerprintScene, sha256 } from "./hashing.js";

export interface CandidateAudit {
  passed: boolean;
  findings: Array<{ code: string; message: string }>;
}

/** Findings that a verified pipeline-generated module is allowed to carry: density itself is expected tool output. */
const GENERATED_WAIVABLE_FINDINGS = new Set(["dense-binary-payload", "topology-dump", "opaque-topology-payload"]);

/** Bare specifiers a candidate may import; everything else is refused at audit time.
 *  The pipeline package itself is NOT importable: candidates must never reach pipeline
 *  state/workspace/CLI/oracle/derive exports (closure plan §7.D2). */
const ALLOWED_BARE_SPECIFIERS = new Set(["three"]);

/** Direct privileged-global uses flagged as unsupported in restricted candidate modes (§7.D3).
 *  This list is diagnostics, not proof: trusted safety is structural (no agent-authored code). */
const PRIVILEGED_GLOBALS = ["process", "fetch", "WebSocket", "eval", "Function", "require", "globalThis", "global", "Bun", "Deno"];

export interface CandidateAuditOptions {
  /**
   * Verified derivation manifests keyed by ABSOLUTE generated-module path, produced by the
   * workspace derivation loader for the CURRENT oracle preparation. Files in this map are
   * audited as trusted pipeline output (density waived); everything else remains subject to
   * the ordinary hand-authored topology restrictions.
   */
  trustedGeneratedModules?: ReadonlyMap<string, unknown>;
  /**
   * Workspace-aware confinement root (the workspace `model/` directory). When present the
   * audited graph must resolve strictly inside it via realpath/lstat — string checks alone
   * never establish the boundary.
   */
  boundaryRoot?: string;
}

export interface CandidateSourceFile {
  path: string;
  sha256: string;
}

export interface CandidateModuleAudit extends CandidateAudit {
  files: string[];
  candidateFiles: CandidateSourceFile[];
  sourceHash: string;
  /** Absolute paths audited as trusted pipeline-generated modules via verified derivation manifests. */
  trustedGeneratedModules: string[];
}

export interface CandidateIdentity {
  candidateHash: string;
  sourceHash: string;
  neutralSceneHash: string;
  candidateFiles: CandidateSourceFile[];
  runtime: CandidateRuntime;
}

export function composeCandidateHash(neutralSceneHash: string, sourceHash: string): string {
  if (!neutralSceneHash || !sourceHash) throw new Error("candidate identity requires neutral scene and source hashes");
  return sha256(canonicalJson({ neutralSceneHash, sourceHash }));
}

export function auditCandidateSource(source: string): CandidateAudit {
  const findings: CandidateAudit["findings"] = [];
  if (/GLTFLoader|(?:load(?:Async)?|fetch|readFile)\s*\([^)]*\.glb|from\s+["'][^"']*\.glb/iu.test(source)) {
    findings.push({ code: "oracle-runtime-load", message: "candidate source loads a GLB/oracle at runtime" });
  }
  if (/data:(?:model\/gltf-binary|application\/octet-stream);base64/iu.test(source)) {
    findings.push({ code: "embedded-oracle", message: "candidate source embeds binary model data" });
  }
  // Dense-payload detection is structural only: element counts, byte size, and embedded
  // binary/base64 payloads. Source-character length is never topology authority, so a small
  // explicit control cage is legal whether it is written as a plain array or a typed array.
  const typedArrayElements = [...source.matchAll(/new\s+(?:Float32|Uint16|Uint32)Array\s*\(\s*\[([\s\S]*?)\]/gu)].reduce((sum, m) => sum + (m[1]?.split(",").filter((s) => s.trim()).length ?? 0), 0);
  const hasDensePayload = /(?:Buffer\.from|atob)\s*\([^,)]{256,}(?:base64|["'])/isu.test(source) || typedArrayElements > 5000;
  if (hasDensePayload) findings.push({ code: "dense-binary-payload", message: "candidate contains a dense binary/topology payload" });
  // Opaque encoded-topology route: very large hex/base64-like string literals decoded at
  // runtime into geometry (the demonstrated evasion encodes hull vertices as HULL_HEX and
  // feeds them through DataView into a BufferGeometry). Detection is deliberately narrow:
  // unbroken hex/base64-ish literals of the size only encoded topology produces.
  const opaqueLiteral = /["'](?:[0-9a-fA-F]{1024,}|[A-Za-z0-9+/=]{2048,})["']/u.test(source);
  if (opaqueLiteral) findings.push({ code: "opaque-topology-payload", message: "candidate embeds and decodes a large opaque hex/base64-like payload" });
  const numericLiteralCount = (source.match(/(?:^|[,[\s])-?\d+(?:\.\d+)?(?=\s*[,\]])/gu) ?? []).length;
  if (numericLiteralCount > 2000 || typedArrayElements > 20000) {
    findings.push({ code: "topology-dump", message: `candidate contains ${numericLiteralCount} numeric literals / ${typedArrayElements} typed elements, consistent with a topology dump` });
  }
  return { passed: findings.length === 0, findings };
}

/**
 * Comment/string/template-aware module lexer. Produces the source with comments blanked so
 * specifier extraction cannot be hidden inside comments, while string literals survive for
 * exact matching. This is defense-in-depth for the audit layer; the sandbox remains the
 * mandatory execution boundary for trusted runs.
 */
export function stripJavascriptComments(source: string): string {
  let output = "";
  let index = 0;
  const length = source.length;
  type Frame = "single" | "double" | "template" | "interp";
  const stack: Frame[] = [];
  const mode = (): Frame | "code" => stack.length ? stack[stack.length - 1]! : "code";
  while (index < length) {
    const char = source[index];
    const next = index + 1 < length ? source[index + 1]! : "";
    const current = mode();
    if (current === "single" || current === "double") {
      output += char;
      if (char === "\\") { output += next ?? ""; index += 2; continue; }
      if ((current === "single" && char === "'") || (current === "double" && char === '"')) stack.pop();
      index += 1;
      continue;
    }
    if (current === "template") {
      output += char;
      if (char === "\\") { output += next ?? ""; index += 2; continue; }
      if (char === "`") stack.pop();
      else if (char === "$" && next === "{") { output += "{"; stack.push("interp"); index += 2; continue; }
      index += 1;
      continue;
    }
    if (current === "interp" && char === "}") {
      output += "}";
      stack.pop();
      index += 1;
      continue;
    }
    // Code context (stack empty or interp body).
    if (char === "/" && next === "/") {
      output += "  ";
      index += 2;
      for (; index < length && source[index] !== "\n"; index += 1) output += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  ";
      index += 2;
      for (;;) {
        if (index >= length) break;
        if (source[index] === "*" && source[index + 1] === "/") { output += "  "; index += 2; break; }
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (char === "'") { output += char; stack.push("single"); index += 1; continue; }
    if (char === '"') { output += char; stack.push("double"); index += 1; continue; }
    if (char === "`") { output += char; stack.push("template"); index += 1; continue; }
    output += char;
    index += 1;
  }
  return output;
}

export interface ScannedImports {
  /** Static import/export-from specifiers in declaration order. */
  static: string[];
  /** Dynamic import() specifiers that are plain string literals. */
  dynamic: string[];
  /** True when ANY dynamic `import(` call appears, regardless of its argument shape. */
  hasDynamicImportCall: boolean;
}

export function scanModuleSpecifiers(source: string): ScannedImports {
  const code = stripJavascriptComments(source);
  const staticSpecifiers: string[] = [];
  for (const match of code.matchAll(/(?:^|[;{}\s)])import\s*(?:[\w$*{}\s,]*?\bfrom\s*)?["']([^"'\n]+)["']/gu)) {
    staticSpecifiers.push(match[1]!);
  }
  for (const match of code.matchAll(/\bexport\s+(?:[\w$*{}\s,]*?\bfrom\s*)["']([^"'\n]+)["']/gu)) {
    staticSpecifiers.push(match[1]!);
  }
  // §7.D1: reject ALL dynamic import syntax. The argument shape is irrelevant — literal,
  // variable, concatenated, or a function call — because any import( is an escape from the
  // statically audited graph.
  const dynamic: string[] = [];
  let hasDynamicImportCall = false;
  for (const match of code.matchAll(/(?:^|[^\w$.])import\s*\(/gu)) {
    hasDynamicImportCall = true;
    const literal = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/gu.exec(code.slice(match.index));
    if (literal) dynamic.push(literal[1]!);
    else dynamic.push("<computed>");
  }
  return { static: staticSpecifiers, dynamic, hasDynamicImportCall };
}

async function assertRealpathInside(root: string, target: string, label: string): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error(`${label} escapes the candidate boundary through a symlink/reparse point: ${target}`);
  const realTarget = await realpath(target);
  const realRoot = await realpath(root);
  const relation = relative(realRoot, realTarget);
  if (!relation || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || relation === ".." || isAbsolute(relation)) {
    throw new Error(`${label} escapes the candidate boundary root: ${target}`);
  }
}

function classifySpecifier(specifier: string): "local" | "absolute" | "url" | "bare" {
  if (/^(?:https?:|file:|data:)/iu.test(specifier)) return "url";
  if (specifier.startsWith(".") || specifier.startsWith("#")) return "local";
  if (isAbsolute(specifier) || /^[a-zA-Z]:[/\\]/u.test(specifier)) return "absolute";
  return "bare";
}

export async function auditCandidateModule(entryPath: string, options: CandidateAuditOptions = {}): Promise<CandidateModuleAudit> {
  const visited = new Set<string>();
  const sources = new Map<string, string>();
  const findings: CandidateAudit["findings"] = [];
  const trusted = options.trustedGeneratedModules ?? new Map<string, unknown>();
  const trustedGeneratedModules: string[] = [];
  const boundaryRoot = options.boundaryRoot ? await realpath(resolve(options.boundaryRoot)) : undefined;
  const visit = async (path: string): Promise<void> => {
    const absolute = resolve(path);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    if (boundaryRoot) {
      try {
        await assertRealpathInside(boundaryRoot, absolute, "candidate file");
      } catch (error) {
        findings.push({ code: "boundary-escape", message: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    const source = await readFile(absolute, "utf8");
    sources.set(absolute, source);
    const fileFindings = auditCandidateSource(source).findings;
    if (trusted.has(absolute)) {
      // Verified derivation manifest bound to the current preparation: this file is pipeline
      // tool output, so density findings are waived while structural/security ones remain.
      trustedGeneratedModules.push(absolute);
      findings.push(...fileFindings.filter((finding) => !GENERATED_WAIVABLE_FINDINGS.has(finding.code)).map((finding) => ({ ...finding, message: `${absolute}: ${finding.message}` })));
    } else {
      findings.push(...fileFindings.map((finding) => ({ ...finding, message: `${absolute}: ${finding.message}` })));
    }
    const scanned = scanModuleSpecifiers(source);
    for (const specifier of scanned.dynamic) {
      findings.push({ code: "dynamic-local-import", message: `${absolute}: dynamic import ${specifier} escapes the staged source graph; use a static import` });
    }
    void scanned.hasDynamicImportCall;
    // §7.D3: flag direct privileged-global use as unsupported in restricted modes.
    const codeOnly = stripJavascriptComments(source);
    for (const globalName of PRIVILEGED_GLOBALS) {
      if (new RegExp(`(?:^|[^\\w$.])${globalName}\\s*(?:\\.|\\(|,|\\)|;|=|\\]|$)`, "u").test(codeOnly)) {
        findings.push({ code: "privileged-global", message: `${absolute}: direct use of privileged global ${globalName} is unsupported in restricted candidate code` });
      }
    }
    for (const specifier of scanned.static) {
      const kind = classifySpecifier(specifier);
      if (kind === "url") {
        findings.push({ code: "url-module-import", message: `${absolute}: URL/data module import is forbidden: ${specifier}` });
        continue;
      }
      if (kind === "absolute") {
        findings.push({ code: "absolute-import", message: `${absolute}: absolute-path import is forbidden: ${specifier}` });
        continue;
      }
      if (kind === "bare") {
        if (!ALLOWED_BARE_SPECIFIERS.has(specifier)) {
          findings.push({ code: "disallowed-bare-import", message: `${absolute}: bare import ${specifier} is not an allowed trusted dependency` });
        }
        continue;
      }
      const base = resolve(dirname(absolute), specifier.split("?")[0]!);
      const candidates = extname(base) ? [base] : [`${base}.js`, `${base}.mjs`, `${base}.ts`, resolve(base, "index.js")];
      let imported: string | undefined;
      for (const candidate of candidates) {
        try { await readFile(candidate, "utf8"); imported = candidate; break; } catch { /* try the next local resolution */ }
      }
      if (!imported) findings.push({ code: "unresolved-local-dependency", message: `${absolute}: cannot audit transitive import ${specifier}` });
      else await visit(imported);
    }
  };
  const entry = resolve(entryPath);
  if (boundaryRoot) await assertRealpathInside(boundaryRoot, entry, "candidate entry");
  await visit(entry);
  const files = [...visited].sort();
  const base = dirname(entry);
  const candidateFiles = files.map((file) => ({
    path: relative(base, file).replaceAll("\\", "/"),
    sha256: sha256(sources.get(file) ?? ""),
  }));
  const sourceHash = sha256(canonicalJson(candidateFiles));
  return { passed: findings.length === 0, findings, files, candidateFiles, sourceHash, trustedGeneratedModules };
}

function commonAncestor(files: string[]): string {
  const roots = new Set(files.map((file) => parse(file).root));
  if (roots.size > 1) throw new Error("candidate local dependencies span multiple filesystem roots");
  let ancestor = dirname(files[0]!);
  for (const file of files.slice(1)) {
    let relation = relative(ancestor, file);
    while (relation === ".." || relation.startsWith("..\\") || relation.startsWith("../")) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
      relation = relative(ancestor, file);
    }
  }
  return ancestor;
}

const STAGE_PREFIX = ".mesh2threejs-candidate-";

/**
 * Staged graphs are imported from a temporary sibling directory. Node resolves bare
 * specifiers by walking up from the importer, so a workspace anywhere without a
 * `node_modules` ancestor (any location outside an installed project tree) would lose
 * access to `three` that the pipeline itself already provides. Expose the pipeline's own
 * resolved `three` package inside the stage root; a directory junction needs no elevated
 * rights on Windows, and `rm recursive` unlinks it without touching the target.
 * Best-effort: when `three` cannot be resolved here the staged import surfaces the real
 * resolution error itself.
 */
async function exposePipelineThree(stageRoot: string): Promise<void> {
  try {
    // three's exports map does not expose ./package.json, so resolve the entry and
    // ascend to the directory that owns a package.json.
    let directory = dirname(createRequire(import.meta.url).resolve("three"));
    while (!(await readFile(join(directory, "package.json"), "utf8").then(() => true, () => false))) {
      const parent = dirname(directory);
      if (parent === directory) throw new Error("cannot locate three package root");
      directory = parent;
    }
    await mkdir(join(stageRoot, "node_modules"), { recursive: true });
    await symlink(directory, join(stageRoot, "node_modules", "three"), process.platform === "win32" ? "junction" : "dir");
  } catch { /* best-effort staging aid; import failures surface from the real import below */ }
}

/**
 * Stages the exact audited transitive source graph in a fresh location and returns it for
 * sandboxed execution. A bare entry-module cache-buster is insufficient because Node's ESM
 * cache keys transitive local imports by URL; a long-lived process could report source B
 * while executing cached helper A. Staging under the graph's common ancestor keeps
 * package.json module-type semantics identical to the original location — bare "three"
 * resolution is provided by the stage-root junction in exposePipelineThree() — while every
 * load sees the bytes that produced the source hash.
 */
export async function stageCandidateGraph(entryPath: string, audit: CandidateModuleAudit): Promise<{ root: string; entry: string }> {
  const entry = resolve(entryPath);
  const hashByAbsolute = new Map(audit.candidateFiles.map((file) => [resolve(dirname(entry), file.path), file.sha256]));
  const files = audit.files.map((file) => resolve(file));
  if (files.some((file) => !hashByAbsolute.has(file))) throw new Error("candidate audit files and hashes disagree");
  const ancestor = commonAncestor([entry, ...files]);
  const root = await mkdtemp(join(ancestor, STAGE_PREFIX));
  try {
    for (const file of files) {
      const bytes = await readFile(file);
      if (sha256(bytes) !== hashByAbsolute.get(file)) throw new Error("candidate source changed during staging; rerun the gate");
      const staged = resolve(root, relative(ancestor, file));
      await mkdir(dirname(staged), { recursive: true });
      await writeFile(staged, bytes, { flag: "wx" });
    }
    await exposePipelineThree(root);
    return { root, entry: resolve(root, relative(ancestor, entry)) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Development-only in-process loader. Trusted runs execute candidates exclusively through
 * the CandidateExecutor sandbox boundary instead of this direct import.
 */
export async function loadCandidateRuntime(path: string, suppliedAudit?: CandidateModuleAudit): Promise<CandidateRuntime> {
  const audit = suppliedAudit ?? await auditCandidateModule(path);
  if (!audit.passed) throw new Error(`candidate source audit failed: ${audit.findings.map((finding) => finding.code).join(", ")}`);
  const stage = await stageCandidateGraph(path, audit);
  let imported: unknown;
  try {
    imported = await import(pathToFileURL(stage.entry).href);
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
  if (!imported || typeof imported !== "object" || typeof (imported as Partial<CandidateModule>).createCandidate !== "function") {
    throw new Error("candidate module must export createCandidate()");
  }
  const built = await (imported as CandidateModule).createCandidate();
  const sourceHash = audit.sourceHash;
  if (built && "root" in built) {
    if (built.root?.isObject3D !== true || typeof built.setPose !== "function") throw new Error("candidate runtime must contain a THREE.Object3D root and setPose()");
    return { ...built, sourceHash };
  }
  if (!built || built.isObject3D !== true) throw new Error("createCandidate() must return a THREE.Object3D or candidate runtime");
  return { root: built, sourceHash, setPose: () => { throw new Error("candidate does not expose physical articulation controls"); } };
}

export async function inspectCandidateIdentity(path: string, neutralPose: Record<string, number> = {}, auditOptions?: CandidateAuditOptions): Promise<CandidateIdentity> {
  const audit = await auditCandidateModule(path, auditOptions);
  const runtime = await loadCandidateRuntime(path, audit);
  if (Object.keys(neutralPose).length) await runtime.setPose(neutralPose);
  runtime.root.updateMatrixWorld(true);
  const neutralSceneHash = fingerprintScene(runtime.root);
  return {
    candidateHash: composeCandidateHash(neutralSceneHash, audit.sourceHash),
    sourceHash: audit.sourceHash,
    neutralSceneHash,
    candidateFiles: audit.candidateFiles.map((file) => ({ ...file })),
    runtime,
  };
}

export async function loadCandidateModule(path: string): Promise<THREE.Object3D> {
  return (await loadCandidateRuntime(path)).root;
}

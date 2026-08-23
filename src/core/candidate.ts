import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, parse, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as THREE from "three";
import type { CandidateModule, CandidateRuntime } from "../types.js";
import { canonicalJson, fingerprintScene, sha256 } from "./hashing.js";

export interface CandidateAudit {
  passed: boolean;
  findings: Array<{ code: string; message: string }>;
}

export interface CandidateSourceFile {
  path: string;
  sha256: string;
}

export interface CandidateModuleAudit extends CandidateAudit {
  files: string[];
  candidateFiles: CandidateSourceFile[];
  sourceHash: string;
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
  const typedArrayElements = [...source.matchAll(/new\s+(?:Float32|Uint16|Uint32)Array\s*\(\s*\[([\s\S]*?)\]/gu)].reduce((sum, m) => sum + (m[1]?.split(",").filter((s) => s.trim()).length ?? 0), 0);
  const hasDensePayload = /(?:Buffer\.from|atob)\s*\([^,)]{256,}(?:base64|["'])/isu.test(source) || typedArrayElements > 5000 || /new\s+(?:Float32|Uint16|Uint32)Array\s*\(\s*\[[\s\S]{4000,}?\]/u.test(source);
  if (hasDensePayload) findings.push({ code: "dense-binary-payload", message: "candidate contains a dense binary/topology payload" });
  const numericLiteralCount = (source.match(/(?:^|[,[\s])-?\d+(?:\.\d+)?(?=\s*[,\]])/gu) ?? []).length;
  if (numericLiteralCount > 2000 || typedArrayElements > 20000) {
    findings.push({ code: "topology-dump", message: `candidate contains ${numericLiteralCount} numeric literals / ${typedArrayElements} typed elements, consistent with a topology dump` });
  }
  return { passed: findings.length === 0, findings };
}

export async function auditCandidateModule(entryPath: string): Promise<CandidateModuleAudit> {
  const visited = new Set<string>();
  const sources = new Map<string, string>();
  const findings: CandidateAudit["findings"] = [];
  const visit = async (path: string): Promise<void> => {
    const absolute = resolve(path);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const source = await readFile(absolute, "utf8");
    sources.set(absolute, source);
    findings.push(...auditCandidateSource(source).findings.map((finding) => ({ ...finding, message: `${absolute}: ${finding.message}` })));
    // Candidate-local imports must be static. The staged source graph is removed once the module is instantiated,
    // so a dynamic import inside createCandidate()/setPose() would resolve into a deleted directory and produce
    // runtime behavior that the audited bytes do not determine.
    for (const match of source.matchAll(/import\s*\(\s*["'](\.[^"']+)["']\s*\)/gu)) {
      findings.push({ code: "dynamic-local-import", message: `${absolute}: dynamic local import ${match[1]} escapes the staged source graph; use a static import` });
    }
    const imports = [...source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/gu)].map((match) => match[1]).filter((value): value is string => Boolean(value));
    for (const specifier of imports) {
      const base = resolve(dirname(absolute), specifier);
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
  await visit(entry);
  const files = [...visited].sort();
  const base = dirname(entry);
  const candidateFiles = files.map((file) => ({
    path: relative(base, file).replaceAll("\\", "/"),
    sha256: sha256(sources.get(file) ?? ""),
  }));
  const sourceHash = sha256(canonicalJson(candidateFiles));
  return { passed: findings.length === 0, findings, files, candidateFiles, sourceHash };
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
 * Stages the exact audited transitive source graph in a fresh location and imports it from there.
 * A bare entry-module cache-buster is insufficient because Node's ESM cache keys transitive local
 * imports by URL; a long-lived process could report source B while executing cached helper A.
 * Staging under the graph's common ancestor keeps bare-specifier resolution (e.g. "three") and
 * package.json module-type semantics identical to the original location, while every load sees the
 * bytes that produced the source hash. Execution from the staged copy is short-lived: the directory
 * is removed as soon as the module graph has been instantiated, which is why the audit requires
 * candidate-local imports to be static.
 */
async function stageCandidateGraph(entryPath: string, audit: CandidateModuleAudit): Promise<{ root: string; entry: string }> {
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
    return { root, entry: resolve(root, relative(ancestor, entry)) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

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

export async function inspectCandidateIdentity(path: string, neutralPose: Record<string, number> = {}): Promise<CandidateIdentity> {
  const audit = await auditCandidateModule(path);
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

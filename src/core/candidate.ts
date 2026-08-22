import { readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
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
  if (/(?:Buffer\.from|atob)\s*\([^,)]{256,}(?:base64|["'])/isu.test(source) || /new\s+(?:Float32|Uint16|Uint32)Array\s*\(\s*\[[\s\S]{4000,}?\]/u.test(source)) {
    findings.push({ code: "dense-binary-payload", message: "candidate contains a dense binary/topology payload" });
  }
  const numericLiteralCount = (source.match(/(?:^|[,[\s])-?\d+(?:\.\d+)?(?=\s*[,\]])/gu) ?? []).length;
  if (numericLiteralCount > 2_000) {
    findings.push({ code: "topology-dump", message: `candidate contains ${numericLiteralCount} numeric array literals, consistent with a topology dump` });
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
    const imports = [...source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["'](\.[^"']+)["']/gu)].map((match) => match[1]).filter((value): value is string => Boolean(value));
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

export async function loadCandidateRuntime(path: string, suppliedAudit?: CandidateModuleAudit): Promise<CandidateRuntime> {
  const audit = suppliedAudit ?? await auditCandidateModule(path);
  if (!audit.passed) throw new Error(`candidate source audit failed: ${audit.findings.map((finding) => finding.code).join(", ")}`);
  const imported: unknown = await import(`${pathToFileURL(path).href}?candidate=${audit.sourceHash}`);
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

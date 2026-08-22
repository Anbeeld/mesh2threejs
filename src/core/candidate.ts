import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type * as THREE from "three";
import type { CandidateModule } from "../types.js";

export interface CandidateAudit {
  passed: boolean;
  findings: Array<{ code: string; message: string }>;
}

export function auditCandidateSource(source: string): CandidateAudit {
  const findings: CandidateAudit["findings"] = [];
  if (/GLTFLoader|load(?:Async)?\s*\([^)]*\.glb|from\s+["'][^"']*\.glb/iu.test(source)) {
    findings.push({ code: "oracle-runtime-load", message: "candidate source loads a GLB/oracle at runtime" });
  }
  if (/data:(?:model\/gltf-binary|application\/octet-stream);base64/iu.test(source)) {
    findings.push({ code: "embedded-oracle", message: "candidate source embeds binary model data" });
  }
  const numericLiteralCount = (source.match(/(?:^|[,[\s])-?\d+(?:\.\d+)?(?=\s*[,\]])/gu) ?? []).length;
  if (numericLiteralCount > 2_000) {
    findings.push({ code: "topology-dump", message: `candidate contains ${numericLiteralCount} numeric array literals, consistent with a topology dump` });
  }
  return { passed: findings.length === 0, findings };
}

export async function loadCandidateModule(path: string): Promise<THREE.Object3D> {
  const source = await readFile(path, "utf8");
  const audit = auditCandidateSource(source);
  if (!audit.passed) throw new Error(`candidate source audit failed: ${audit.findings.map((finding) => finding.code).join(", ")}`);
  const imported: unknown = await import(`${pathToFileURL(path).href}?candidate=${Date.now()}`);
  if (!imported || typeof imported !== "object" || typeof (imported as Partial<CandidateModule>).createCandidate !== "function") {
    throw new Error("candidate module must export createCandidate()");
  }
  const candidate = await (imported as CandidateModule).createCandidate();
  if (!candidate || candidate.isObject3D !== true) throw new Error("createCandidate() must return a THREE.Object3D");
  return candidate;
}

import { resolve } from "node:path";
import { canonicalJson, sha256 } from "./hashing.js";
import type { CandidateIsolation } from "./candidate-sandbox.js";

/**
 * Execution provenance classification (closure plan §6.C5). This is a RUNTIME FACT derived
 * from the executed source graph and the backend class — never a caller option.
 *
 * - `trusted-host-sandbox`: the backend itself is an actually verified host isolation
 *   adapter supplied by the deployment.
 * - `trusted-derived-generated`: the executed graph contains ONLY pipeline-owned files
 *   (canonical scaffold entry, generated registry, five-way-verified generated modules),
 *   so no builder-authored executable code crossed the boundary even though the process
 *   itself is an ordinary resource-bounded child.
 * - `development-untrusted`: anything else (hand-authored candidate code under a plain
 *   backend). It can never certify.
 */
export type CandidateExecutionAuthority = "trusted-derived-generated" | "trusted-host-sandbox" | "development-untrusted";

const PIPELINE_OWNED_FILE = /(^|[\\/])model\.mjs$|(^|[\\/])\.generated[\\/]registry\.mjs$/u;

export function classifyExecutionAuthority(
  backendIsolation: CandidateIsolation,
  audit: { files: ReadonlyArray<string>; trustedGeneratedModules: ReadonlyArray<string> },
): CandidateExecutionAuthority {
  if (backendIsolation === "trusted-host-sandbox") return "trusted-host-sandbox";
  const generated = new Set(audit.trustedGeneratedModules.map((file) => resolve(file)));
  const nonGenerated = audit.files.filter((file) => !generated.has(resolve(file)));
  const pure = generated.size > 0 && nonGenerated.length > 0 && nonGenerated.every((file) => PIPELINE_OWNED_FILE.test(file));
  return pure ? "trusted-derived-generated" : "development-untrusted";
}

/** Stable provenance identity for a sandbox backend instance. */
export function backendIdentity(input: { name: string; detail?: string }): string {
  return sha256(canonicalJson({ name: input.name, ...(input.detail !== undefined ? { detail: input.detail } : {}) }));
}

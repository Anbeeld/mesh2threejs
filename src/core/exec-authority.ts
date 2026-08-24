import { resolve } from "node:path";
import { canonicalJson, sha256 } from "./hashing.js";
import type { CandidateIsolation } from "./candidate-sandbox.js";

/**
 * Execution provenance classification (closure plan §6.C5, remaining-closure §2). This is a
 * RUNTIME FACT derived from the audited source graph BEFORE execution and the backend
 * class — never a caller option, never inferred after the fact.
 *
 * - `trusted-host-sandbox`: the backend itself is an actually verified host isolation
 *   adapter supplied by the deployment.
 * - `trusted-derived-generated`: the AUDITED graph contains ONLY pipeline-owned files
 *   (byte-verified scaffold entry, byte-verified generated registry, five-way-verified
 *   generated modules), so no builder-authored executable code will run even though the
 *   process itself is an ordinary resource-bounded child.
 * - `development-untrusted`: anything else (hand-authored candidate code under a plain
 *   backend). It can never certify.
 */
export type CandidateExecutionAuthority = "trusted-derived-generated" | "trusted-host-sandbox" | "development-untrusted";

export type GraphFileOwner = "pipeline-scaffold" | "pipeline-registry" | "trusted-generated" | "builder-authored";

export interface ExecutableGraphAuthorityFile {
  absolutePath: string;
  stagedPath: string | null;
  sha256: string;
  owner: GraphFileOwner;
}

/**
 * The exact executable-graph authority established from audited bytes BEFORE execution
 * (remaining closure §2.1). Computed internally by the CandidateExecutor boundary; no
 * caller may submit it.
 */
export interface ExecutableGraphAuthority {
  authority: CandidateExecutionAuthority;
  sourceHash: string;
  files: Array<ExecutableGraphAuthorityFile>;
  backendIdentity: string;
}

/** Stable provenance identity for a sandbox backend instance. */
export function backendIdentity(input: { name: string; detail?: string }): string {
  return sha256(canonicalJson({ name: input.name, ...(input.detail !== undefined ? { detail: input.detail } : {}) }));
}

/**
 * Byte expectations trusted code computes from canonical run state BEFORE asking the
 * executor to run anything (§2.2/§2.3). The executor refuses to import anything until the
 * live graph matches these exact bytes.
 */
export interface DerivedGraphExpectations {
  /** Exact expected bytes of the derived entry module (`MODEL_DERIVED_SCAFFOLD`). */
  scaffoldSource: string;
  /** Absolute path of the pipeline-owned registry module. */
  registryPath: string;
  /** Exact expected bytes of the registry regenerated from currently bound phases. */
  registrySource: string;
}

export interface GraphAuditInput {
  entryPath: string;
  sourceHash: string;
  files: ReadonlyArray<string>;
  /** Absolute path -> content hash as computed by the just-completed audit. */
  hashByAbsolute: ReadonlyMap<string, string>;
  trustedGeneratedModules: ReadonlyArray<string>;
  expectations?: DerivedGraphExpectations;
}

const DRIFT_PREFIX = "DERIVED_";

/**
 * Establishes the executable-graph authority ledger from the audited graph. In derived
 * expectation mode every file must be byte-verified pipeline output: any drift throws
 * BEFORE staging/execution (§2.2–§2.4), and no builder-authored file can ever pass.
 */
export function establishExecutableGraphAuthority(input: GraphAuditInput & { backendIsolation: CandidateIsolation; backendIdentityHash: string }): ExecutableGraphAuthority {
  const entry = resolve(input.entryPath);
  const registry = input.expectations ? resolve(input.expectations.registryPath) : null;
  const generated = new Set(input.trustedGeneratedModules.map((file) => resolve(file)));
  const files: Array<ExecutableGraphAuthorityFile> = [];
  let builderAuthored = 0;
  for (const file of input.files) {
    const absolute = resolve(file);
    const hash = input.hashByAbsolute.get(absolute);
    if (!hash) throw new Error(`${DRIFT_PREFIX}EXECUTABLE_GRAPH_AUDIT_INCOMPLETE: ${absolute} lacks an audit hash`);
    let owner: GraphFileOwner;
    if (input.expectations && absolute === entry) {
      if (hash !== sha256(input.expectations.scaffoldSource)) throw new Error("DERIVED_ENTRY_DRIFT: the canonical derived model entry was replaced or edited before execution; restore the pipeline-owned scaffold");
      owner = "pipeline-scaffold";
    } else if (registry !== null && absolute === registry) {
      if (input.expectations && hash !== sha256(input.expectations.registrySource)) throw new Error("DERIVED_REGISTRY_DRIFT: the generated registry does not match trusted derive state before execution; rerun derive instead of editing it");
      owner = "pipeline-registry";
    } else if (generated.has(absolute)) {
      owner = "trusted-generated";
    } else {
      owner = "builder-authored";
      builderAuthored += 1;
      if (input.expectations) throw new Error(`DERIVED_EXECUTABLE_GRAPH_UNTRUSTED: ${absolute} is not a verified pipeline-generated module bound to the current derivation state`);
    }
    files.push({ absolutePath: absolute, stagedPath: null, sha256: hash, owner });
  }
  const authority: CandidateExecutionAuthority =
    input.backendIsolation === "trusted-host-sandbox"
      ? "trusted-host-sandbox"
      : builderAuthored === 0 && files.length > 0 && generated.size > 0
        ? "trusted-derived-generated"
        : "development-untrusted";
  return { authority, sourceHash: input.sourceHash, files, backendIdentity: input.backendIdentityHash };
}

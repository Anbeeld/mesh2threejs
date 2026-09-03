import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256 } from "./hashing.js";
import { ConstructionRoutingError } from "./construction-mode.js";
import { discoverAuthorSpecs, readAuthorSpec, type AuthoredBinding } from "./authored-candidate.js";
import { authorSpecHash, type AuthorSpec } from "./author-spec.js";
import { AUTHORED_COMPILER_VERSION } from "./author-spec.js";
import type { TaskState } from "./state.js";
import { verifyStyleBindingCurrent, type StyleBinding } from "./style-binding.js";
import type { OraclePreparationBinding } from "./oracle.js";

/**
 * Construction freeze identity (stylized-authored mode design §19). Freeze binds: oracle
 * preparation identity, style binding, all AuthorSpec files, the feature plan, the author
 * compiler version, the compiled generated modules, the candidate source graph, the neutral
 * geometry hash, the articulation behavior hash, and final-draft capture evidence. Any source
 * change invalidates the freeze (FREEZE_STALE).
 */

export interface AuthoringFreezeInputs {
  oracleBinding: OraclePreparationBinding;
  styleBinding: StyleBinding | null;
  specs: AuthorSpec[];
  authoredBindings: Record<string, AuthoredBinding>;
  featurePlanHash: string | null;
  compiledGraphHash: string;
  candidateHash: string;
  neutralGeometryHash: string;
  articulationBehaviorHash: string | null;
}

export function authorSpecSetHash(specs: AuthorSpec[]): string {
  return sha256(canonicalJson(specs.map((spec) => ({ semanticId: spec.semanticId, hash: authorSpecHash(spec) })).sort((a, b) => a.semanticId.localeCompare(b.semanticId))));
}

/** Computes the freeze payload identity from CURRENT trusted facts (design §19). */
export function computeAuthoringFreezeIdentity(inputs: AuthoringFreezeInputs): string {
  return sha256(canonicalJson({
    kind: "stylized-authored-freeze-identity",
    compilerVersion: AUTHORED_COMPILER_VERSION,
    oracleBinding: inputs.oracleBinding.identity,
    styleBinding: inputs.styleBinding?.styleBindingHash ?? null,
    authorSpecHash: authorSpecSetHash(inputs.specs),
    authoredBindings: canonicalJson(inputs.authoredBindings),
    featurePlanHash: inputs.featurePlanHash,
    compiledGraphHash: inputs.compiledGraphHash,
    candidateHash: inputs.candidateHash,
    neutralGeometryHash: inputs.neutralGeometryHash,
    articulationBehaviorHash: inputs.articulationBehaviorHash,
  }));
}

/** Hash of the feature budget artifact `model/stylized/feature-plan.yaml` (design §15). */
export async function featurePlanHash(workspaceRoot: string): Promise<string | null> {
  try {
    return sha256(await readFile(join(workspaceRoot, "model", "stylized", "feature-plan.yaml")));
  } catch {
    return null;
  }
}

/**
 * Freeze staleness check (design §19/§33.5): re-reads the CURRENT spec files, style input,
 * and feature plan and verifies the recorded freeze still reproduces. Changing an AuthorSpec,
 * style reference/brief, feature plan, oracle preparation, or compiler version invalidates
 * the freeze (FREEZE_STALE).
 */
export async function verifyFreezeCurrent(state: TaskState, workspaceRoot: string): Promise<void> {
  const freeze = state.authoring?.freeze;
  if (!freeze) return;
  if (state.authoring!.status === "authoring") return;
  // Compiler version drift changes freeze identity by definition.
  if (freeze.compilerVersion !== AUTHORED_COMPILER_VERSION) {
    throw new ConstructionRoutingError("FREEZE_STALE", `freeze was created with author-compiler ${freeze.compilerVersion}, but the installation compiles with ${AUTHORED_COMPILER_VERSION}; reopen authoring and re-freeze`);
  }
  const discovered = await discoverAuthorSpecs(workspaceRoot);
  const specs: AuthorSpec[] = [];
  for (const entry of discovered) specs.push(await readAuthorSpec(workspaceRoot, entry.path));
  const liveSpecHash = authorSpecSetHash(specs);
  if (freeze.authorSpecHash !== liveSpecHash) {
    throw new ConstructionRoutingError("FREEZE_STALE", "an authored spec changed after freeze; reopen authoring, recompile, and re-freeze");
  }
  if (state.authoring!.styleBinding) {
    await verifyStyleBindingCurrent(workspaceRoot, state.authoring!.styleBinding!);
  }
  const liveFeaturePlanHash = await featurePlanHash(workspaceRoot);
  if ((freeze.featurePlanHash ?? null) !== liveFeaturePlanHash) {
    throw new ConstructionRoutingError("FREEZE_STALE", "the feature plan changed after freeze; reopen authoring and re-freeze");
  }
  // Oracle binding drift is detected against the live preparation by the caller
  // (verifyWorkspaceOraclePreparation) before freeze checks run.
  void workspaceRoot;
}
import { canonicalJson, sha256 } from "./hashing.js";
import type { AuthorshipMode, CertificationLevel, ProfileId } from "../types.js";
import type { ProjectManifest, ReferenceIndex } from "./workspace.js";

/**
 * Reconstruction policy bound at trusted-run creation. The builder never chooses these
 * fields during a run: they are fixed by the run authority and every transition is
 * validated against them. `geometryAuthority` is constant for v1: the prepared oracle
 * is the only geometry authority.
 */
export interface RunPolicy {
  profile: ProfileId;
  style: string;
  certification: CertificationLevel;
  authorshipMode: AuthorshipMode;
  geometryAuthority: "prepared-oracle";
  /** Selected oracle reference path (workspace-relative) and its admitted bytes hash. */
  oracleReference: { path: string; sha256: string } | null;
  subjectContractHash: string | null;
  goal: string;
}

export type PolicyDecisionSource = "safe-default" | "user-policy" | "trusted-router" | "administrative";

export interface PolicyDecision {
  field: keyof RunPolicy;
  value: unknown;
  source: PolicyDecisionSource;
  reason: string;
}

export interface RunPolicyIdentity {
  schemaVersion: 1;
  policy: RunPolicy;
  decisions: PolicyDecision[];
}

/**
 * Computes the canonical policy identity for a project manifest and its reference index.
 * Unlike the legacy project configuration identity, this includes the authorship mode,
 * the goal, and the selected oracle reference bytes, so a builder editing project.json to
 * weaken authorship or swap the oracle changes the hash instead of silently adopting it.
 */
export function projectPolicyIdentity(project: ProjectManifest, references: ReferenceIndex): RunPolicy {
  const oracleRecord = project.oracle
    ? references.records.find((record) => record.kind === "oracle" && record.operationalPath === project.oracle)
    : undefined;
  if (project.oracle && !oracleRecord) throw new Error(`project oracle selection is absent from the reference index: ${project.oracle}`);
  return {
    profile: project.profile,
    style: project.style,
    certification: project.certification,
    authorshipMode: project.authorshipMode ?? "independent",
    geometryAuthority: "prepared-oracle",
    oracleReference: oracleRecord ? { path: oracleRecord.operationalPath, sha256: oracleRecord.sha256 } : null,
    subjectContractHash: project.subjectContract
      ? references.records.find((record) => record.kind === "document" && record.operationalPath === project.subjectContract)?.sha256 ?? null
      : null,
    goal: project.goal,
  };
}

export function projectPolicyHash(policy: RunPolicy, decisions: PolicyDecision[] = []): string {
  const identity: RunPolicyIdentity = { schemaVersion: 1, policy, decisions };
  return sha256(canonicalJson(identity));
}

const DEFAULT_POLICY_SOURCES = new Set<PolicyDecisionSource>(["safe-default", "user-policy", "trusted-router", "administrative"]);

/**
 * Validates that a proposed policy was created by a legitimate authority. Builders may only
 * obtain the safe default; any weaker-than-default field (independent authorship, alternate
 * profile/style, weaker certification) must arrive with a recorded non-builder decision.
 */
export function validatePolicyCreation(policy: RunPolicy, decisions: PolicyDecision[], defaults: { hasOracle: boolean; routedProfile: ProfileId }): void {
  const seen = new Set<keyof RunPolicy>();
  for (const decision of decisions) {
    if (!DEFAULT_POLICY_SOURCES.has(decision.source)) throw new Error(`policy decision source is not recognized: ${String(decision.source)}`);
    if (decision.source !== "safe-default") seen.add(decision.field);
  }
  const expectedAuthorship: AuthorshipMode = defaults.hasOracle ? "derived" : "independent";
  if (policy.authorshipMode !== expectedAuthorship && !seen.has("authorshipMode")) {
    throw new Error("non-default authorship mode requires a recorded user/router/administrative policy decision");
  }
  if (policy.profile !== defaults.routedProfile && !seen.has("profile")) {
    throw new Error("non-default profile requires a recorded user/router/administrative policy decision");
  }
  if (defaults.hasOracle && policy.geometryAuthority !== "prepared-oracle") {
    throw new Error("a 3D-oracle run always uses the prepared oracle as geometry authority");
  }
  for (const decision of decisions) {
    if (decision.source === "safe-default" && seen.has(decision.field)) continue;
  }
}

export const TRUSTED_SANDBOX_UNAVAILABLE = "TRUSTED_CANDIDATE_SANDBOX_UNAVAILABLE" as const;

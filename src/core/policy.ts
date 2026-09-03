import { canonicalJson, sha256 } from "./hashing.js";
import type { AuthorshipMode, CertificationLevel, ConstructionMode, ProfileId } from "../types.js";
import { effectiveConstructionMode, isConstructionMode } from "./construction-mode.js";
import type { ProjectManifest, ReferenceIndex } from "./workspace.js";

/**
 * Reconstruction policy bound at trusted-run creation. The builder never chooses these
 * fields during a run: they are fixed by the run authority and every transition is
 * validated against them. `geometryAuthority` is constant for v1: the prepared oracle
 * is the only geometry authority.
 */
export interface RunPolicy {
  profile: ProfileId;
  /**
   * Construction architecture (stylized-authored design §5). Optional for legacy policy
   * records: an absent field behaves as "derived-faithful" and keeps historical policy
   * identities byte-identical. Declared in project.json for stylized workspaces; switching
   * requires a new evidence chain / rebind.
   */
  constructionMode?: ConstructionMode;
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
  if (project.constructionMode !== undefined && !isConstructionMode(project.constructionMode)) {
    throw new Error(`project constructionMode is invalid: ${String(project.constructionMode)}`);
  }
  return {
    profile: project.profile,
    style: project.style,
    certification: project.certification,
    authorshipMode: project.authorshipMode ?? "independent",
    // Legacy policy records stay byte-identical: the field participates only when declared.
    ...(project.constructionMode ? { constructionMode: project.constructionMode } : {}),
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

/**
 * Computes the safe-default run policy from trusted inputs only (closure plan §4.A3):
 * the project's goal/reference selection, the trusted router, and the presence of an
 * oracle. The builder request identifies a workspace; it never carries authorship mode,
 * thresholds, certification level, or any other policy field. A project manifest that
 * requests a non-default configuration is NOT silently adopted — beginRun surfaces
 * POLICY_APPROVAL_REQUIRED instead.
 */
export function computeSafeDefaultPolicy(input: {
  project: ProjectManifest;
  references: ReferenceIndex;
  routedProfile: ProfileId;
  defaultStyle: string;
  defaultCertification: CertificationLevel;
}): { policy: RunPolicy; decisions: PolicyDecision[] } | { blocked: "POLICY_APPROVAL_REQUIRED"; conflicts: string[] } {
  const { project, references, routedProfile } = input;
  const expectedAuthorship: AuthorshipMode = project.oracle ? "derived" : "independent";
  const conflicts: string[] = [];
  if (project.profile !== routedProfile) conflicts.push(`project profile ${project.profile} differs from the trusted router result ${routedProfile}`);
  if (project.style && project.style !== input.defaultStyle) conflicts.push(`project style ${project.style} is not the package default`);
  if (project.certification && project.certification !== input.defaultCertification) conflicts.push(`project certification ${project.certification} is not the package default`);
  if (project.authorshipMode && project.authorshipMode !== expectedAuthorship) conflicts.push(`project authorshipMode ${project.authorshipMode} is not the safe default for this subject`);
  const declaredMode = project.constructionMode;
  if (declaredMode !== undefined && !isConstructionMode(declaredMode)) conflicts.push(`project constructionMode ${String(declaredMode)} is not a recognized construction mode`);
  // Stylized-authored is a deliberate workspace-creation choice (design §5.1): the project
  // manifest declares it and the decision is recorded as user-policy, so builder-initiated
  // runs cannot flip into it silently while explicitly created stylized workspaces bind it.
  if (conflicts.length) return { blocked: "POLICY_APPROVAL_REQUIRED", conflicts };
  const identity = projectPolicyIdentity(project, references);
  const decisions: PolicyDecision[] = [
    { field: "authorshipMode", value: expectedAuthorship, source: "safe-default", reason: "derived from oracle presence" },
    { field: "profile", value: routedProfile, source: "trusted-router", reason: "router classification of the project goal" },
  ];
  if (declaredMode) {
    decisions.push({ field: "constructionMode", value: declaredMode, source: "user-policy", reason: "declared in project.json at workspace creation" });
  }
  void effectiveConstructionMode;
  return { policy: identity, decisions };
}

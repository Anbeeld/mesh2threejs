import type { CertificationLevel, ProfileId } from "../types.js";
import { canonicalJson, sha256 } from "./hashing.js";

export const EVALUATOR_VERSION = "8";
export const MEASUREMENT_VERSION = "4";

/**
 * Execution provenance of the sandbox that evaluated the candidate (closure plan §6.C5):
 * `trusted-derived-generated` means every executed module was pipeline-generated
 * (no builder-authored executable code crossed the boundary); `trusted-host-sandbox`
 * requires an actually verified host isolation backend; everything else is untrusted.
 */
export type CandidateIsolationIdentity = "trusted-derived-generated" | "trusted-host-sandbox" | "development-untrusted";

export interface EvaluationIdentity {
  schemaVersion: 2;
  evaluatorVersion: string;
  measurementVersion: string;
  profile: ProfileId;
  profileContractHash: string;
  styleContractHash: string;
  subjectContractHash: string | null;
  certification: CertificationLevel;
  oraclePreparationHash: string;
  preparedOracleHash: string;
  authoritativeDimensionsHash: string | null;
  candidateSourceHash: string;
  candidateNeutralHash: string;
  /** Identity of the trusted toolchain that evaluated the candidate. */
  toolchainId: string | null;
  /** Hash of the immutable run policy governing the evaluation. */
  projectPolicyHash: string | null;
  /** Isolation classification of the sandbox that executed the candidate. */
  candidateIsolation: CandidateIsolationIdentity;
}

export function createEvaluationIdentity(input: Omit<EvaluationIdentity, "schemaVersion">): EvaluationIdentity {
  for (const [key, value] of Object.entries(input)) {
    if (value === "") throw new Error(`evaluation identity is missing ${key}`);
  }
  return { schemaVersion: 2, ...input };
}

export function evaluationIdentityHash(identity: EvaluationIdentity): string {
  if (identity.schemaVersion !== 2) throw new Error("evaluation identity schema is unsupported");
  return sha256(canonicalJson(identity));
}

/** True when the identity was produced under a trusted execution authority and trusted toolchain. */
export function isTrustedEvaluationIdentity(identity: EvaluationIdentity): boolean {
  return identity.toolchainId !== null
    && (identity.candidateIsolation === "trusted-derived-generated" || identity.candidateIsolation === "trusted-host-sandbox");
}

export function optionalContractHash(value: unknown): string | null {
  return value === null || value === undefined ? null : sha256(canonicalJson(value));
}

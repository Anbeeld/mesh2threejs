import type { CertificationLevel, ProfileId } from "../types.js";
import { canonicalJson, sha256 } from "./hashing.js";

export const EVALUATOR_VERSION = "5";
export const MEASUREMENT_VERSION = "2";

export interface EvaluationIdentity {
  schemaVersion: 1;
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
}

export function createEvaluationIdentity(input: Omit<EvaluationIdentity, "schemaVersion">): EvaluationIdentity {
  for (const [key, value] of Object.entries(input)) {
    if (value === "") throw new Error(`evaluation identity is missing ${key}`);
  }
  return { schemaVersion: 1, ...input };
}

export function evaluationIdentityHash(identity: EvaluationIdentity): string {
  if (identity.schemaVersion !== 1) throw new Error("evaluation identity schema is unsupported");
  return sha256(canonicalJson(identity));
}

export function optionalContractHash(value: unknown): string | null {
  return value === null || value === undefined ? null : sha256(canonicalJson(value));
}

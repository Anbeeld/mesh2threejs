import type * as THREE from "three";
import type { GateReport, ProfileId } from "../types.js";
import { snapshotScene } from "./geometry.js";
import { fingerprintScene } from "./hashing.js";
import { evaluateGenericProfile } from "../profiles/generic.js";
import { evaluateTankProfile } from "../profiles/tank.js";
import { evaluateLowPolyStyle, lowPolyFaithful, type StyleContract } from "../styles/low-poly.js";

export interface EvaluationBundle {
  oracleHash: string;
  candidateHash: string;
  deterministic: GateReport;
  style: GateReport;
  passed: boolean;
}

export function evaluateCandidate(input: {
  oracle: THREE.Object3D;
  candidate: THREE.Object3D;
  profile: ProfileId;
  style?: StyleContract;
  authoritativeDimensions?: { hullLength: number; overallLength: number; width: number; height: number };
  certification?: "exact-real" | "oracle-relative";
}): EvaluationBundle {
  const oracleSnapshot = snapshotScene(input.oracle);
  const candidateSnapshot = snapshotScene(input.candidate);
  const deterministic = input.profile === "tank"
    ? evaluateTankProfile(oracleSnapshot, candidateSnapshot, {
        certification: input.certification ?? "oracle-relative",
        ...(input.authoritativeDimensions ? { authoritativeDimensions: input.authoritativeDimensions } : {}),
      })
    : evaluateGenericProfile(oracleSnapshot, candidateSnapshot);
  const style = evaluateLowPolyStyle(oracleSnapshot, candidateSnapshot, input.style ?? lowPolyFaithful);
  return {
    oracleHash: fingerprintScene(input.oracle),
    candidateHash: fingerprintScene(input.candidate),
    deterministic,
    style,
    passed: deterministic.passed && style.passed,
  };
}

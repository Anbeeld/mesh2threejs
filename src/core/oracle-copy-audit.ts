import { canonicalJson, sha256 } from "./hashing.js";
import type { SceneSnapshot } from "../types.js";

/**
 * Source-copy contamination audit (stylized-authored mode design §16.3). A diagnostic/backstop
 * mechanism for blatant copied oracle elements: quantize oracle and candidate triangles into
 * canonical world coordinates, use orientation-insensitive triangle hashes, and compute exact
 * triangle-area overlap per connected candidate component. Architecture — never this
 * heuristic — remains the primary enforcement of the no-source-copy invariant.
 *
 * v1 rollout: diagnostic WARNING only. It intentionally does NOT fail on a few matching
 * landmark vertices, one intentionally aligned planar triangle, or simple coordinates that
 * legitimately match source dimensions. Hard-fail thresholds wait for calibration against
 * authored examples (design Q3).
 */

/** Quantization grid in canonical world units: exact geometric coincidence, not fuzzy similarity. */
const QUANTIZATION = 1e-4;

interface TriangleSignature {
  key: string;
  area: number;
}

function quantize(value: number): string {
  return (Math.round(value / QUANTIZATION) * QUANTIZATION).toFixed(10);
}

function triangleArea(a: readonly number[], b: readonly number[], c: readonly number[]): number {
  const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
  const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}

/**
 * Orientation-insensitive signature: the three quantized vertices sorted, so the same
 * triangle matches regardless of winding.
 */
function triangleSignature(positions: Float64Array, base: number): TriangleSignature {
  const vertices: string[][] = [];
  for (let vertex = 0; vertex < 3; vertex += 1) {
    const offset = base + vertex * 3;
    vertices.push([quantize(positions[offset]!), quantize(positions[offset + 1]!), quantize(positions[offset + 2]!)]);
  }
  vertices.sort((a, b) => (a[0]! + a[1]! + a[2]!).toString().localeCompare((b[0]! + b[1]! + b[2]!).toString()));
  const numeric = vertices.map((vertex) => vertex.map(Number));
  const area = triangleArea(numeric[0]!, numeric[1]!, numeric[2]!);
  return { key: `t:${vertices.map((vertex) => vertex.join(",")).join("|")}`, area };
}

export interface CopyAuditComponentFinding {
  componentId: string;
  candidateArea: number;
  matchedArea: number;
  matchedTriangleCount: number;
  matchedFraction: number;
  flagged: boolean;
}

export interface CopyAuditReport {
  schemaVersion: 1;
  kind: "mesh2threejs-oracle-copy-audit";
  /** v1 is diagnostic-only; hard failure waits for calibrated thresholds (design Q3). */
  enforcement: "diagnostic-warning";
  status: "clean" | "warning";
  quantization: number;
  oracleTriangleCount: number;
  candidateTriangleCount: number;
  components: CopyAuditComponentFinding[];
  /** Fraction of candidate area composed of exact oracle triangles, whole object. */
  totalMatchedFraction: number;
  warnings: string[];
  reportHash: string;
}

export interface CopyAuditOptions {
  /** A candidate component is flagged when this fraction of ITS area is exact oracle triangles. */
  componentFlagFraction?: number;
  /** Components smaller than this fraction of the whole candidate area are not flagged (micro coincidences). */
  minComponentAreaFraction?: number;
}

/** Fraction of a component's own area that must be exact oracle triangles to flag a copy. */
const DEFAULT_COMPONENT_FLAG_FRACTION = 0.9;
/** Ignore microscopic components whose entire area is a vanishing fraction of the candidate. */
const DEFAULT_MIN_COMPONENT_AREA_FRACTION = 0.01;

export function auditOracleCopy(oracle: SceneSnapshot, candidate: SceneSnapshot, options: CopyAuditOptions = {}): CopyAuditReport {
  const componentFlagFraction = options.componentFlagFraction ?? DEFAULT_COMPONENT_FLAG_FRACTION;
  const minComponentAreaFraction = options.minComponentAreaFraction ?? DEFAULT_MIN_COMPONENT_AREA_FRACTION;
  const oracleTriangles = new Map<string, number>();
  const oraclePositions = oracle.triangleData.positions;
  for (let triangle = 0; triangle < oracle.triangleCount; triangle += 1) {
    const signature = triangleSignature(oraclePositions, triangle * 9);
    oracleTriangles.set(signature.key, (oracleTriangles.get(signature.key) ?? 0) + signature.area);
  }
  const candidatePositions = candidate.triangleData.positions;
  const componentIndexToId = new Map<number, string>();
  candidate.triangleData.componentIds.forEach((id, index) => componentIndexToId.set(index, id));
  const perComponent = new Map<string, { area: number; matchedArea: number; matchedTriangles: number }>();
  let totalArea = 0;
  let totalMatchedArea = 0;
  for (let triangle = 0; triangle < candidate.triangleCount; triangle += 1) {
    const signature = triangleSignature(candidatePositions, triangle * 9);
    const componentIndex = candidate.triangleData.componentIndices[triangle]!;
    const componentId = componentIndexToId.get(componentIndex) ?? `component-${componentIndex}`;
    const bucket = perComponent.get(componentId) ?? { area: 0, matchedArea: 0, matchedTriangles: 0 };
    bucketAdd(bucket, signature, oracleTriangles);
    perComponent.set(componentId, bucket);
    totalArea += signature.area;
    if (oracleTriangles.has(signature.key)) totalMatchedArea += signature.area;
  }
  const components: CopyAuditComponentFinding[] = [...perComponent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([componentId, entry]) => {
      const matchedFraction = entry.area > 0 ? entry.matchedArea / entry.area : 0;
      const areaFraction = totalArea > 0 ? entry.area / totalArea : 0;
      const flagged = matchedFraction >= componentFlagFraction && areaFraction >= minComponentAreaFraction;
      return {
        componentId,
        candidateArea: Number(entry.area.toFixed(6)),
        matchedArea: Number(entry.matchedArea.toFixed(6)),
        matchedTriangleCount: entry.matchedTriangles,
        matchedFraction: Number(matchedFraction.toFixed(4)),
        flagged,
      };
    });
  const warnings: string[] = [];
  for (const component of components.filter((item) => item.flagged)) {
    warnings.push(`candidate component ${component.componentId} is ${Math.round(component.matchedFraction * 100)}% exact oracle triangles by area — an accidentally pasted oracle component is likely; author this form from scratch instead`);
  }
  const report: CopyAuditReport = {
    schemaVersion: 1,
    kind: "mesh2threejs-oracle-copy-audit",
    enforcement: "diagnostic-warning",
    status: warnings.length ? "warning" : "clean",
    quantization: QUANTIZATION,
    oracleTriangleCount: oracle.triangleCount,
    candidateTriangleCount: candidate.triangleCount,
    components,
    totalMatchedFraction: Number((totalArea > 0 ? totalMatchedArea / totalArea : 0).toFixed(4)),
    warnings,
    reportHash: "",
  };
  report.reportHash = sha256(canonicalJson({ ...report, reportHash: undefined }));
  return report;
}

function bucketAdd(bucket: { area: number; matchedArea: number; matchedTriangles: number }, signature: TriangleSignature, oracleTriangles: Map<string, number>): void {
  bucket.area += signature.area;
  if (oracleTriangles.has(signature.key)) {
    bucket.matchedArea += signature.area;
    bucket.matchedTriangles += 1;
  }
}
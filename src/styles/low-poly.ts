import type { GateReport, GateRow, SceneComponent, SceneSnapshot } from "../types.js";
import { rowsToWorkorders } from "../core/compare.js";

export interface StyleContract {
  schemaVersion: 1;
  id: "low-poly-faithful";
  preserve: { macroGeometry: true; orientation: true; articulation: true; repeatedCounts: true };
  simplify: string[];
  omit: string[];
  complexity: { triangleTarget: number; triangleMax: number; meshTarget: number; meshMax: number; materialTarget: number; materialMax: number; segmentRange: [number, number] };
  appearance: { shading: "flat-or-faceted"; materialVocabulary: "simple-pbr"; texturePolicy: "none-or-generated"; palette: "subject-derived" };
  macroRelativeTolerance: number;
  centerRelativeTolerance: number;
  featureSizePolicy?: { minimum: number; unit: "object-unit"; appliesTo: string[] };
}

export const lowPolyFaithful: StyleContract = {
  schemaVersion: 1,
  id: "low-poly-faithful",
  preserve: { macroGeometry: true, orientation: true, articulation: true, repeatedCounts: true },
  simplify: ["curvature tessellation", "track links", "small mechanical substructure", "surface microdetail"],
  omit: ["micro fasteners", "sub-pixel seams", "non-critical hidden mechanisms"],
  complexity: { triangleTarget: 25_000, triangleMax: 75_000, meshTarget: 160, meshMax: 500, materialTarget: 12, materialMax: 32, segmentRange: [6, 16] },
  appearance: { shading: "flat-or-faceted", materialVocabulary: "simple-pbr", texturePolicy: "none-or-generated", palette: "subject-derived" },
  macroRelativeTolerance: 0.01,
  centerRelativeTolerance: 0.01,
};

export function regularPolygonFacetingCorridor(radius: number, segments: number): number {
  if (radius < 0 || !Number.isFinite(radius) || !Number.isInteger(segments) || segments < 3) throw new Error("invalid regular polygon inputs");
  return radius * (1 - Math.cos(Math.PI / segments));
}

function componentTriangles(snapshot: SceneSnapshot, component: SceneComponent): number {
  return component.triangleIndices.length;
}

function estimateSegments(snapshot: SceneSnapshot, component: SceneComponent): number | null {
  const triangles = componentTriangles(snapshot, component);
  if (triangles < 24) return null;
  return Math.max(3, Math.round(triangles / 4));
}

function matchesSemanticPattern(semanticId: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u").test(semanticId);
}

function featureSizeRows(candidate: SceneSnapshot, contract: StyleContract): GateRow[] {
  const policy = contract.featureSizePolicy;
  if (!policy) return [];
  return Object.values(candidate.components)
    .filter((component) => policy.appliesTo.some((pattern) => matchesSemanticPattern(component.id, pattern)))
    .map((component) => {
      const positiveDimensions = component.bounds.size.filter((value) => value > Number.EPSILON);
      const actual = positiveDimensions.length ? Math.min(...positiveDimensions) : 0;
      const passed = actual >= policy.minimum;
      return {
        code: `style.feature-size.${component.id}`,
        component: component.id,
        passed,
        score: passed ? 100 : Math.max(0, (actual / policy.minimum) * 100),
        severity: "major" as const,
        message: `${component.id} minimum physical feature: ${actual.toFixed(4)} ${policy.unit}; required ${policy.minimum.toFixed(4)} ${policy.unit}`,
        oracleValue: policy.minimum,
        candidateValue: actual,
        deviation: actual - policy.minimum,
      };
    });
}

function componentEnvelopeRows(oracle: SceneSnapshot, candidate: SceneSnapshot, contract: StyleContract): GateRow[] {
  const rows: GateRow[] = [];
  const oracleScale = Math.max(...Object.values(oracle.components).flatMap((component) => component.bounds.size), 1);
  for (const oracleComponent of Object.values(oracle.components)) {
    const candidateComponent = candidate.components[oracleComponent.id];
    if (!candidateComponent) {
      if (oracleComponent.critical) {
        rows.push({
          code: `style.critical.${oracleComponent.id}`,
          component: oracleComponent.id,
          passed: false,
          score: 0,
          severity: "critical",
          message: `critical feature ${oracleComponent.id} cannot be omitted by style`,
          oracleValue: "present",
          candidateValue: "missing",
        });
      }
      continue;
    }
    const segments = estimateSegments(candidate, candidateComponent);
    const radius = Math.max(...oracleComponent.bounds.size) / 2;
    const faceting = segments ? regularPolygonFacetingCorridor(radius, segments) : 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const oracleSize = oracleComponent.bounds.size[axis] ?? 0;
      const candidateSize = candidateComponent.bounds.size[axis] ?? 0;
      const allowed = oracleScale * contract.macroRelativeTolerance + faceting * 2 + 1e-6;
      const deviation = candidateSize - oracleSize;
      const passed = Math.abs(deviation) <= allowed;
      rows.push({
        code: `style.envelope.${oracleComponent.id}.${axis}`,
        component: oracleComponent.id,
        passed,
        score: passed ? 100 : Math.max(0, 100 - (Math.abs(deviation) / Math.max(oracleSize, 0.01)) * 1000),
        severity: "critical",
        message: `${oracleComponent.id} envelope axis ${axis}: allowed ${allowed.toFixed(4)}, deviation ${deviation.toFixed(4)}`,
        oracleValue: oracleSize,
        candidateValue: candidateSize,
        deviation,
        normalizedDeviation: Math.abs(deviation) / Math.max(oracleSize, 0.01),
      });
      const centerDeviation = (candidateComponent.bounds.center[axis] ?? 0) - (oracleComponent.bounds.center[axis] ?? 0);
      const centerAllowed = oracleScale * contract.centerRelativeTolerance;
      rows.push({
        code: `style.center.${oracleComponent.id}.${axis}`,
        component: oracleComponent.id,
        passed: Math.abs(centerDeviation) <= centerAllowed,
        score: Math.max(0, 100 - (Math.abs(centerDeviation) / Math.max(oracleScale, 0.01)) * 1000),
        severity: "critical",
        message: `${oracleComponent.id} center axis ${axis}: allowed ${centerAllowed.toFixed(4)}, deviation ${centerDeviation.toFixed(4)}`,
        oracleValue: oracleComponent.bounds.center[axis] ?? 0,
        candidateValue: candidateComponent.bounds.center[axis] ?? 0,
        deviation: centerDeviation,
        normalizedDeviation: Math.abs(centerDeviation) / oracleScale,
      });
    }
  }
  return rows;
}

export function evaluateLowPolyStyle(oracle: SceneSnapshot, candidate: SceneSnapshot, contract: StyleContract): GateReport {
  const rows = [...componentEnvelopeRows(oracle, candidate, contract), ...featureSizeRows(candidate, contract)];
  const complexity: Array<[string, number, number]> = [
    ["triangles", candidate.triangleCount, contract.complexity.triangleMax],
    ["meshes", candidate.meshCount, contract.complexity.meshMax],
    ["materials", candidate.materialCount, contract.complexity.materialMax],
  ];
  for (const [name, actual, maximum] of complexity) {
    rows.push({
      code: `style.complexity.${name}`,
      component: "whole-object",
      passed: actual <= maximum,
      score: actual <= maximum ? 100 : 0,
      severity: "major",
      message: `${name}: ${actual}; maximum ${maximum}`,
      oracleValue: maximum,
      candidateValue: actual,
      deviation: actual - maximum,
    });
  }
  return {
    profile: oracle.metadata.name.toLowerCase().includes("tank") ? "tank" : "generic",
    passed: rows.every((row) => row.passed),
    score: rows.length ? Math.min(...rows.map((row) => row.score)) : 100,
    rows,
    workorders: rowsToWorkorders(rows),
  };
}

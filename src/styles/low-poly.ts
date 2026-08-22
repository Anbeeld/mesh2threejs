import { readFile, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GateReport, GateRow, SceneComponent, SceneSnapshot } from "../types.js";
import { rowsToWorkorders } from "../core/compare.js";
import { validateStyleContract } from "../core/schema.js";
import { canonicalJson, sha256 } from "../core/hashing.js";

export interface StyleContract {
  schemaVersion: 1;
  id: string;
  preserve: { macroGeometry: true; orientation: true; articulation: true; repeatedCounts: true };
  simplify: string[];
  omit: string[];
  complexity: { triangleTarget: number; triangleMax: number; meshTarget: number; meshMax: number; materialTarget: number; materialMax: number; segmentRange: [number, number] };
  appearance: { shading: "flat-or-faceted"; materialVocabulary: "simple-pbr"; texturePolicy: "none-or-generated"; palette: "subject-derived" };
  macroRelativeTolerance: number;
  centerRelativeTolerance: number;
  featureSizePolicy?: { minimum: number; unit: "object-unit"; appliesTo: string[] };
}

function stylePath(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) throw new Error(`unknown style: ${id}`);
  return fileURLToPath(new URL(`../../styles/${id}.json`, import.meta.url));
}

function parseStyleContract(id: string, source: string): { contract: StyleContract; hash: string } {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error(`style contract ${id} is not valid JSON`); }
  const validation = validateStyleContract(value);
  if (!validation.valid || (value as { id?: unknown }).id !== id) throw new Error(`style contract ${id} is invalid or unknown`);
  const contract = structuredClone(value) as StyleContract;
  return { contract, hash: sha256(canonicalJson(contract)) };
}

export function getStyleContract(id: string): { contract: StyleContract; hash: string } {
  try { return parseStyleContract(id, readFileSync(stylePath(id), "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`unknown style: ${id}`);
    throw error;
  }
}

export async function loadStyleContract(id: string): Promise<{ contract: StyleContract; hash: string }> {
  try {
    const path = stylePath(id);
    return await new Promise((resolve, reject) => readFile(path, "utf8", (error, source) => error ? reject(error) : resolve(parseStyleContract(id, source))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`unknown style: ${id}`);
    throw error;
  }
}

export const lowPolyFaithful: StyleContract = getStyleContract("low-poly-faithful").contract;

export function regularPolygonFacetingCorridor(radius: number, segments: number): number {
  if (radius < 0 || !Number.isFinite(radius) || !Number.isInteger(segments) || segments < 3) throw new Error("invalid regular polygon inputs");
  return radius * (1 - Math.cos(Math.PI / segments));
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
    const segments = candidateComponent.representation.segmentCounts.length ? Math.max(...candidateComponent.representation.segmentCounts) : null;
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

function colorDistance(a: number, b: number): number {
  const channel = (value: number, shift: number): number => ((value >> shift) & 0xff) / 255;
  return Math.hypot(channel(a, 16) - channel(b, 16), channel(a, 8) - channel(b, 8), channel(a, 0) - channel(b, 0));
}

function representationRows(oracle: SceneSnapshot, candidate: SceneSnapshot, contract: StyleContract): GateRow[] {
  const rows: GateRow[] = [];
  for (const component of Object.values(candidate.components)) {
    if (component.representation.segmentCounts.length) {
      const minimum = Math.min(...component.representation.segmentCounts);
      const maximum = Math.max(...component.representation.segmentCounts);
      const passed = minimum >= contract.complexity.segmentRange[0] && maximum <= contract.complexity.segmentRange[1];
      rows.push({ code: `style.segments.${component.id}`, component: component.id, passed, score: passed ? 100 : 0, severity: "major", message: `${component.id} declared radial/curve segments ${minimum}-${maximum}; required ${contract.complexity.segmentRange[0]}-${contract.complexity.segmentRange[1]}`, oracleValue: `${contract.complexity.segmentRange[0]}-${contract.complexity.segmentRange[1]}`, candidateValue: `${minimum}-${maximum}` });
    }
    rows.push({ code: `style.shading.${component.id}`, component: component.id, passed: component.representation.flatOrFaceted, score: component.representation.flatOrFaceted ? 100 : 0, severity: "major", message: component.representation.flatOrFaceted ? `${component.id} uses flat or explicitly faceted geometry` : `${component.id} must use flat shading or explicit faceting` });
    rows.push({ code: `style.material.${component.id}`, component: component.id, passed: component.representation.simplePbr, score: component.representation.simplePbr ? 100 : 0, severity: "major", message: component.representation.simplePbr ? `${component.id} uses the simple PBR vocabulary` : `${component.id} uses a material outside the simple PBR vocabulary` });
    rows.push({ code: `style.texture.${component.id}`, component: component.id, passed: component.representation.generatedOrNoTextures, score: component.representation.generatedOrNoTextures ? 100 : 0, severity: "major", message: component.representation.generatedOrNoTextures ? `${component.id} uses no texture or a generated texture` : `${component.id} uses a texture without generated-source metadata` });
    const expectedColors = oracle.components[component.id]?.representation.colors ?? [];
    if (expectedColors.length && component.representation.colors.length) {
      const distance = Math.max(...component.representation.colors.map((color) => Math.min(...expectedColors.map((expected) => colorDistance(color, expected)))));
      const passed = distance <= 0.35;
      rows.push({ code: `style.palette.${component.id}`, component: component.id, passed, score: passed ? 100 : Math.max(0, 100 - distance * 100), severity: "major", message: `${component.id} subject-palette distance ${distance.toFixed(3)}; maximum 0.350`, oracleValue: 0.35, candidateValue: distance, deviation: distance - 0.35 });
    }
  }
  return rows;
}

export function evaluateLowPolyStyle(oracle: SceneSnapshot, candidate: SceneSnapshot, contract: StyleContract, phase = oracle.metadata.name.toLowerCase().includes("tank") ? "style-fabrication" : "style-complexity"): GateReport {
  const rows = [...componentEnvelopeRows(oracle, candidate, contract), ...featureSizeRows(candidate, contract), ...representationRows(oracle, candidate, contract)];
  const complexity: Array<[string, number, number, number]> = [
    ["triangles", candidate.triangleCount, contract.complexity.triangleTarget, contract.complexity.triangleMax],
    ["meshes", candidate.meshCount, contract.complexity.meshTarget, contract.complexity.meshMax],
    ["materials", candidate.materialCount, contract.complexity.materialTarget, contract.complexity.materialMax],
  ];
  for (const [name, actual, target, maximum] of complexity) {
    const passed = actual <= maximum;
    const score = actual <= target ? 100 : passed ? Math.max(1, 100 - ((actual - target) / Math.max(maximum - target, 1)) * 50) : 0;
    rows.push({
      code: `style.complexity.${name}`,
      component: "whole-object",
      passed,
      score,
      severity: "major",
      message: `${name}: ${actual}; target ${target}; maximum ${maximum}`,
      oracleValue: target,
      candidateValue: actual,
      deviation: actual - target,
    });
  }
  for (const row of rows) row.phase = phase;
  return {
    profile: oracle.metadata.name.toLowerCase().includes("tank") ? "tank" : "generic",
    passed: rows.every((row) => row.passed),
    score: rows.length ? Math.min(...rows.map((row) => row.score)) : 100,
    rows,
    workorders: rowsToWorkorders(rows),
  };
}

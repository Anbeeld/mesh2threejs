import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256 } from "./hashing.js";
import type { SceneSnapshot, Bounds3 } from "../types.js";
import { ConstructionRoutingError } from "./construction-mode.js";

/**
 * Oracle measurement guides (stylized-authored mode design §12.3/§13). The oracle helps
 * heavily with coordinates — that is a feature, not a violation. Guide APIs return
 * LOW-DIMENSIONAL measurement data (bounds, centers, origins, dimensions, attachment points,
 * distances) and NEVER source topology. This is the trusted equivalent of the studio's
 * measurement interactions for non-UI agent workflows.
 */

export interface SemanticGuide {
  semanticId: string;
  bounds: Bounds3;
  center: [number, number, number];
  origin: [number, number, number] | null;
  dimensions: { length: number; width: number; height: number };
  parentSemanticId?: string;
  triangleCount: number;
}

export interface SemanticMeasurementGuide {
  schemaVersion: 1;
  kind: "mesh2threejs-oracle-guides";
  oraclePreparationIdentity: string;
  semantics: SemanticGuide[];
  /** Selected pairwise distances between semantic centers (anchor-to-attachment facts). */
  centerDistances: Array<{ a: string; b: string; distance: number }>;
  reportHash: string;
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt((a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2);
}

/**
 * Builds low-dimensional measurement guides for the requested oracle semantics (or all).
 * Returns scalar facts only — no source topology ever leaves this boundary.
 */
export function buildOracleGuides(oracle: SceneSnapshot, oraclePreparationIdentity: string, semanticIds?: ReadonlySet<string> | readonly string[]): SemanticMeasurementGuide {
  const wanted = semanticIds ? (semanticIds instanceof Set ? semanticIds : new Set(semanticIds as ReadonlySet<string>)) : null;
  for (const id of wanted ?? []) {
    if (!oracle.components[id]) throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `unknown oracle semantic: ${id}`);
  }
  const semantics: SemanticGuide[] = Object.values(oracle.components)
    .filter((component) => !wanted || wanted.has(component.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((component) => ({
      semanticId: component.id,
      bounds: structuredClone(component.bounds),
      center: [Number(component.bounds.center[0].toFixed(6)), Number(component.bounds.center[1].toFixed(6)), Number(component.bounds.center[2].toFixed(6))],
      origin: component.origin ? [Number(component.origin[0].toFixed(6)), Number(component.origin[1].toFixed(6)), Number(component.origin[2].toFixed(6))] : null,
      dimensions: {
        length: Number(component.bounds.size[0].toFixed(6)),
        width: Number(component.bounds.size[2].toFixed(6)),
        height: Number(component.bounds.size[1].toFixed(6)),
      },
      ...(component.parentSemanticId ? { parentSemanticId: component.parentSemanticId } : {}),
      triangleCount: component.triangleIndices.length,
    }));
  const centerDistances: Array<{ a: string; b: string; distance: number }> = [];
  for (let index = 0; index < semantics.length; index += 1) {
    for (let other = index + 1; other < semantics.length; other += 1) {
      const a = semantics[index]!;
      const b = semantics[other]!;
      if (!a.origin || !b.origin) continue;
      centerDistances.push({ a: a.semanticId, b: b.semanticId, distance: Number(distance(a.origin, b.origin).toFixed(6)) });
    }
  }
  const guide: SemanticMeasurementGuide = {
    schemaVersion: 1,
    kind: "mesh2threejs-oracle-guides",
    oraclePreparationIdentity,
    semantics,
    centerDistances,
    reportHash: "",
  };
  guide.reportHash = sha256(canonicalJson({ ...guide, reportHash: undefined }));
  return guide;
}

/**
 * Measurement notebook (design §12.4): named measurement facts recorded by the builder. The
 * notebook is allowed candidate-DEVELOPMENT input because it records measurements, not source
 * geometry. It must not contain source triangles, full vertex lists, raw mesh buffers, or
 * automatically exported source contours — enforced structurally below.
 */

export interface MeasurementNotebookEntry {
  name: string;
  value: number | number[] | [number, number, number];
  source: string;
  referenceSceneHash?: string;
  notes?: string;
}

export interface MeasurementNotebook {
  schemaVersion: 1;
  kind: "mesh2threejs-measurement-notebook";
  oraclePreparationIdentity?: string;
  measurements: MeasurementNotebookEntry[];
}

/** Any array longer than 3 channels is a vertex/contour list, not a measurement. */
const MEASUREMENT_ARRAY_LIMIT = 3;
const NOTEBOOK_ENTRY_LIMIT = 512;

export function validateMeasurementNotebook(input: unknown): MeasurementNotebook {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", "measurement notebook must be an object");
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "mesh2threejs-measurement-notebook") {
    throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", "measurement notebook schemaVersion/kind is invalid");
  }
  if (!Array.isArray(record.measurements)) throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", "measurement notebook measurements must be an array");
  if (record.measurements.length > NOTEBOOK_ENTRY_LIMIT) {
    throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `measurement notebook exceeds ${NOTEBOOK_ENTRY_LIMIT} entries; it records measurement facts, not geometry`);
  }
  const measurements: MeasurementNotebookEntry[] = [];
  const seen = new Set<string>();
  for (const raw of record.measurements) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", "measurement entry must be an object");
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== "string" || !entry.name.trim()) throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", "measurement name must be a non-empty string");
    if (seen.has(entry.name)) throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `duplicate measurement name: ${entry.name}`);
    seen.add(entry.name);
    if (typeof entry.value !== "number" && !Array.isArray(entry.value)) {
      throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `measurement ${entry.name} value must be a number or [x,y,z]`);
    }
    if (Array.isArray(entry.value)) {
      if (entry.value.length > MEASUREMENT_ARRAY_LIMIT) {
        throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `measurement ${entry.name} carries an array of ${entry.value.length} values; notebooks hold scalars/points, never vertex or contour lists`);
      }
      for (const item of entry.value) {
        if (typeof item !== "number" || !Number.isFinite(item)) throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `measurement ${entry.name} values must be finite numbers`);
      }
    } else if (!Number.isFinite(entry.value)) {
      throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `measurement ${entry.name} value must be finite`);
    }
    if (typeof entry.source !== "string" || !entry.source.trim()) throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `measurement ${entry.name} requires a source label`);
    measurements.push({
      name: entry.name,
      value: Array.isArray(entry.value) ? (entry.value.length === 3 ? [entry.value[0]!, entry.value[1]!, entry.value[2]!] as [number, number, number] : entry.value.map(Number)) : entry.value,
      source: entry.source,
      ...(typeof entry.referenceSceneHash === "string" ? { referenceSceneHash: entry.referenceSceneHash } : {}),
      ...(typeof entry.notes === "string" ? { notes: entry.notes } : {}),
    });
  }
  return {
    schemaVersion: 1,
    kind: "mesh2threejs-measurement-notebook",
    ...(typeof record.oraclePreparationIdentity === "string" ? { oraclePreparationIdentity: record.oraclePreparationIdentity } : {}),
    measurements,
  };
}

/** Reads + validates the workspace measurement notebook if one exists (design §12.4). */
export async function loadMeasurementNotebook(workspaceRoot: string): Promise<MeasurementNotebook | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(workspaceRoot, "model", "stylized", "measurements.json"), "utf8"));
    return validateMeasurementNotebook(value);
  } catch (error) {
    if (error instanceof ConstructionRoutingError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `measurement notebook is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
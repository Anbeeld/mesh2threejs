import { canonicalJson, sha256 } from "./hashing.js";
import { ConstructionRoutingError } from "./construction-mode.js";

/**
 * AuthorSpec v1 (stylized-authored mode design §9). The declarative authored geometry
 * specification: the builder describes WHAT geometry should exist, and trusted code compiles
 * it. Like the derived repair spec, authored input is DATA — there are no JS expressions,
 * imports, callbacks, paths, URLs, code strings, or oracle references. Unlike repairs, the
 * vocabulary creates geometry from zero: no target/keep/drop/simplify mutation semantics and
 * no operation whose primary purpose is converting source shape into final authored geometry
 * (design D6). There is no `loftFromOracleContour` / `resampleOracle` / `simplifyOracleContour`:
 * loft rings are authored numbers only.
 */

export const AUTHOR_SPEC_SCHEMA_VERSION = 1;
export const AUTHORED_COMPILER_VERSION = "1.0.0";

/** Per-part complexity ceilings (design §9.4): oversized payloads fail before compilation. */
export const AUTHOR_PART_VERTEX_CEILING = 8000;
export const AUTHOR_PART_TRIANGLE_CEILING = 16_000;
/** Whole-spec ceilings across all parts of one semantic. */
export const AUTHOR_SPEC_TRIANGLE_CEILING = 40_000;

export type Vec3 = readonly [number, number, number];

export interface AuthoredMaterial {
  /** Declared color space (design §28.3): colors are sRGB [0,1] triplets; the compiler converts deterministically. */
  colorSpace: "srgb";
  color: Vec3;
  roughness?: number;
  metalness?: number;
  flatShading?: boolean;
}

export type AuthoredGeometry =
  | { kind: "box"; size: Vec3 }
  | { kind: "cylinder"; radius: number; height: number; segments: number; axis?: "x" | "y" | "z" }
  | { kind: "tube"; from: Vec3; to: Vec3; radius: number; segments: number }
  | { kind: "prism"; polygon: Array<[number, number]>; extrude: number; axis?: "x" | "y" | "z" }
  | { kind: "loft"; rings: Vec3[][]; closeEnds?: boolean }
  | { kind: "mesh"; positions: number[]; indices: number[] };

export interface AuthoredPart {
  name: string;
  geometry: AuthoredGeometry;
  material?: AuthoredMaterial;
  /** Optional parent-local transform applied on top of the semantic origin. */
  translate?: Vec3;
  rotateDegrees?: Vec3;
}

/**
 * One authored semantic root (design §28.1): exactly one per required semantic, optionally
 * parented under a pivot/group semantic. Geometry coordinates are semantic-local (design
 * §28.4); the semantic origin places the root in its parent's frame.
 */
export interface AuthorSpec {
  schemaVersion: 1;
  semanticId: string;
  /** Transform-only parents (pivots) own zero geometry; a semantic root may live under one. */
  parentSemanticId?: string;
  kind?: "group" | "mesh-root";
  origin?: Vec3;
  material?: AuthoredMaterial;
  parts: AuthoredPart[];
}

class AuthorSpecValidationError extends ConstructionRoutingError {
  constructor(message: string) {
    super("AUTHOR_SPEC_INVALID", message);
    this.name = "AuthorSpecValidationError";
  }
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new AuthorSpecValidationError(`${label} must be a finite number`);
  return value;
}

function finiteVec3(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new AuthorSpecValidationError(`${label} must be [x,y,z]`);
  return [finiteNumber(value[0], `${label}[0]`), finiteNumber(value[1], `${label}[1]`), finiteNumber(value[2], `${label}[2]`)];
}

function optionalVec3(record: Record<string, unknown>, key: string, label: string): Vec3 | undefined {
  return key in record ? finiteVec3(record[key], label) : undefined;
}

function assertOnlyKeys(object: Record<string, unknown>, allowed: ReadonlyArray<string>, label: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new AuthorSpecValidationError(`${label} carries unknown key "${key}"`);
  }
}

/** AuthorSpec is data: any recognizable executable/reference payload fails closed (design §9.4). */
function assertNoExecutablePayload(record: Record<string, unknown>, label: string): void {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      const lowered = value.toLowerCase();
      if (/(?:^|\s)(?:import|require|eval|function\s*\(|=>|new\s+function)\b/u.test(lowered) || lowered.includes("http://") || lowered.includes("https://") || lowered.includes("file://")) {
        throw new AuthorSpecValidationError(`${label}.${key} carries executable code, a callback, or a URL; authored specs are pure data`);
      }
    }
  }
}

function validateMaterial(value: unknown, label: string): AuthoredMaterial {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthorSpecValidationError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  assertOnlyKeys(record, ["colorSpace", "color", "roughness", "metalness", "flatShading"], label);
  assertNoExecutablePayload(record, label);
  if (record.colorSpace !== "srgb") throw new AuthorSpecValidationError(`${label}.colorSpace must be "srgb" (design §28.3: one declared representation)`);
  const color = finiteVec3(record.color, `${label}.color`);
  for (const channel of color) if (channel < 0 || channel > 1) throw new AuthorSpecValidationError(`${label}.color channels must lie in [0,1]`);
  const material: AuthoredMaterial = { colorSpace: "srgb", color };
  if ("roughness" in record) {
    const roughness = finiteNumber(record.roughness, `${label}.roughness`);
    if (roughness < 0 || roughness > 1) throw new AuthorSpecValidationError(`${label}.roughness must lie in [0,1]`);
    material.roughness = roughness;
  }
  if ("metalness" in record) {
    const metalness = finiteNumber(record.metalness, `${label}.metalness`);
    if (metalness < 0 || metalness > 1) throw new AuthorSpecValidationError(`${label}.metalness must lie in [0,1]`);
    material.metalness = metalness;
  }
  if ("flatShading" in record) {
    if (typeof record.flatShading !== "boolean") throw new AuthorSpecValidationError(`${label}.flatShading must be boolean`);
    material.flatShading = record.flatShading;
  }
  return material;
}

function validatePolygon(value: unknown, label: string): Array<[number, number]> {
  if (!Array.isArray(value) || value.length < 3) throw new AuthorSpecValidationError(`${label} must contain at least 3 [x,y] vertices`);
  return value.map((vertex, index) => {
    if (!Array.isArray(vertex) || vertex.length !== 2) throw new AuthorSpecValidationError(`${label}[${index}] must be [x,y]`);
    return [finiteNumber(vertex[0], `${label}[${index}].x`), finiteNumber(vertex[1], `${label}[${index}].y`)] as [number, number];
  });
}

function validateGeometry(value: unknown, label: string): AuthoredGeometry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthorSpecValidationError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "box") {
    assertOnlyKeys(record, ["kind", "size"], label);
    const size = finiteVec3(record.size, `${label}.size`);
    if (size.some((axis) => axis <= 0)) throw new AuthorSpecValidationError(`${label}.size axes must be positive`);
    return { kind: "box", size };
  }
  if (kind === "cylinder") {
    assertOnlyKeys(record, ["kind", "radius", "height", "segments", "axis"], label);
    if (record.axis !== undefined && record.axis !== "x" && record.axis !== "y" && record.axis !== "z") throw new AuthorSpecValidationError(`${label}.axis must be x, y, or z`);
    const segments = finiteNumber(record.segments, `${label}.segments`);
    if (!Number.isInteger(segments) || segments < 3 || segments > 64) throw new AuthorSpecValidationError(`${label}.segments must be an integer in [3, 64]`);
    const radius = finiteNumber(record.radius, `${label}.radius`);
    if (radius <= 0) throw new AuthorSpecValidationError(`${label}.radius must be positive`);
    const height = finiteNumber(record.height, `${label}.height`);
    if (height <= 0) throw new AuthorSpecValidationError(`${label}.height must be positive`);
    return { kind: "cylinder", radius, height, segments, ...(record.axis !== undefined ? { axis: record.axis as "x" | "y" | "z" } : {}) };
  }
  if (kind === "tube") {
    assertOnlyKeys(record, ["kind", "from", "to", "radius", "segments"], label);
    const segments = finiteNumber(record.segments, `${label}.segments`);
    if (!Number.isInteger(segments) || segments < 3 || segments > 64) throw new AuthorSpecValidationError(`${label}.segments must be an integer in [3, 64]`);
    const radius = finiteNumber(record.radius, `${label}.radius`);
    if (radius <= 0) throw new AuthorSpecValidationError(`${label}.radius must be positive`);
    const from = finiteVec3(record.from, `${label}.from`);
    const to = finiteVec3(record.to, `${label}.to`);
    return { kind: "tube", from, to, radius, segments };
  }
  if (kind === "prism") {
    assertOnlyKeys(record, ["kind", "polygon", "extrude", "axis"], label);
    if (record.axis !== undefined && record.axis !== "x" && record.axis !== "y" && record.axis !== "z") throw new AuthorSpecValidationError(`${label}.axis must be x, y, or z`);
    const extrude = finiteNumber(record.extrude, `${label}.extrude`);
    if (extrude <= 0) throw new AuthorSpecValidationError(`${label}.extrude must be positive`);
    const polygon = validatePolygon(record.polygon, `${label}.polygon`);
    const vertexCeiling = AUTHOR_PART_VERTEX_CEILING;
    if (polygon.length * 6 > vertexCeiling) throw new AuthorSpecValidationError(`${label} exceeds the ${vertexCeiling} vertex ceiling`);
    return { kind: "prism", polygon, extrude, ...(record.axis !== undefined ? { axis: record.axis as "x" | "y" | "z" } : {}) };
  }
  if (kind === "loft") {
    assertOnlyKeys(record, ["kind", "rings", "closeEnds"], label);
    if (!Array.isArray(record.rings) || record.rings.length < 2) throw new AuthorSpecValidationError(`${label}.rings must contain at least 2 rings`);
    const rings = record.rings.map((ring, ringIndex) => {
      if (!Array.isArray(ring) || ring.length < 3) throw new AuthorSpecValidationError(`${label}.rings[${ringIndex}] must contain at least 3 [x,y,z] vertices`);
      return ring.map((vertex, vertexIndex) => finiteVec3(vertex, `${label}.rings[${ringIndex}][${vertexIndex}]`));
    });
    // v1 requires equal vertex counts per ring (design Q2): the builder chooses correspondence deliberately.
    const first = rings[0]!.length;
    for (const [index, ring] of rings.entries()) {
      if (ring.length !== first) throw new AuthorSpecValidationError(`${label}.rings[${index}] has ${ring.length} vertices but ring 0 has ${first}; v1 requires equal counts per ring`);
    }
    if ("closeEnds" in record && typeof record.closeEnds !== "boolean") throw new AuthorSpecValidationError(`${label}.closeEnds must be boolean`);
    const vertexTotal = rings.reduce((sum, ring) => sum + ring.length, 0);
    if (vertexTotal > AUTHOR_PART_VERTEX_CEILING) throw new AuthorSpecValidationError(`${label} exceeds the ${AUTHOR_PART_VERTEX_CEILING} vertex ceiling`);
    return { kind: "loft", rings, ...("closeEnds" in record ? { closeEnds: record.closeEnds as boolean } : {}) };
  }
  if (kind === "mesh") {
    assertOnlyKeys(record, ["kind", "positions", "indices"], label);
    if (!Array.isArray(record.positions) || !Array.isArray(record.indices)) throw new AuthorSpecValidationError(`${label}.positions and .indices must be arrays`);
    const positions = record.positions.map((value, index) => finiteNumber(value, `${label}.positions[${index}]`));
    if (positions.length === 0 || positions.length % 3 !== 0) throw new AuthorSpecValidationError(`${label}.positions must be a non-empty multiple of 3`);
    const vertexCount = positions.length / 3;
    if (vertexCount > AUTHOR_PART_VERTEX_CEILING) throw new AuthorSpecValidationError(`${label} exceeds the ${AUTHOR_PART_VERTEX_CEILING} vertex ceiling`);
    const indices = record.indices.map((value, index) => {
      const indexValue = finiteNumber(value, `${label}.indices[${index}]`);
      if (!Number.isInteger(indexValue) || indexValue < 0 || indexValue >= vertexCount) throw new AuthorSpecValidationError(`${label}.indices[${index}] is outside the vertex range`);
      return indexValue;
    });
    if (indices.length === 0 || indices.length % 3 !== 0) throw new AuthorSpecValidationError(`${label}.indices must be a non-empty multiple of 3`);
    if (indices.length / 3 > AUTHOR_PART_TRIANGLE_CEILING) throw new AuthorSpecValidationError(`${label} exceeds the ${AUTHOR_PART_TRIANGLE_CEILING} triangle ceiling`);
    return { kind: "mesh", positions, indices };
  }
  throw new AuthorSpecValidationError(`unknown authored geometry kind: ${String(kind)}`);
}

/**
 * Mechanically validates one authored semantic spec. Structural JSON parsing already excludes
 * code; this adds exact-key checks, finite numeric checks, index-range checks, complexity
 * ceilings, and the executable-payload scan. Semantic existence/parent legality are checked
 * at composition time against the registered semantic set.
 */
export function validateAuthorSpec(input: unknown): AuthorSpec {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AuthorSpecValidationError("author spec must be an object");
  const spec = input as Record<string, unknown>;
  assertOnlyKeys(spec, ["schemaVersion", "semanticId", "parentSemanticId", "kind", "origin", "material", "parts"], "author spec");
  assertNoExecutablePayload(spec, "author spec");
  if (spec.schemaVersion !== AUTHOR_SPEC_SCHEMA_VERSION) throw new AuthorSpecValidationError(`author spec schemaVersion must be ${AUTHOR_SPEC_SCHEMA_VERSION}`);
  if (typeof spec.semanticId !== "string" || !spec.semanticId.trim()) throw new AuthorSpecValidationError("author spec semanticId must be a non-empty string");
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(spec.semanticId)) throw new AuthorSpecValidationError(`author spec semanticId must be kebab-case: ${String(spec.semanticId)}`);
  if ("parentSemanticId" in spec && (typeof spec.parentSemanticId !== "string" || !spec.parentSemanticId.trim())) {
    throw new AuthorSpecValidationError("author spec parentSemanticId must be a non-empty string when present");
  }
  if ("kind" in spec && spec.kind !== "group" && spec.kind !== "mesh-root") throw new AuthorSpecValidationError(`author spec kind must be "group" or "mesh-root"`);
  const origin = optionalVec3(spec, "origin", "origin");
  const material = "material" in spec ? validateMaterial(spec.material, "material") : undefined;
  if (!Array.isArray(spec.parts)) throw new AuthorSpecValidationError("author spec parts must be an array");
  const parts: AuthoredPart[] = [];
  let triangleBudget = 0;
  const partNames = new Set<string>();
  for (const raw of spec.parts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AuthorSpecValidationError("author part must be an object");
    const record = raw as Record<string, unknown>;
    assertOnlyKeys(record, ["name", "geometry", "material", "translate", "rotateDegrees"], "author part");
    assertNoExecutablePayload(record, "author part");
    if (typeof record.name !== "string" || !record.name.trim()) throw new AuthorSpecValidationError("author part name must be a non-empty string");
    if (partNames.has(record.name)) throw new AuthorSpecValidationError(`duplicate authored part name: ${record.name}`);
    partNames.add(record.name);
    const geometry = validateGeometry(record.geometry, `part ${record.name}.geometry`);
    triangleBudget += estimateTriangleCount(geometry);
    if (triangleBudget > AUTHOR_SPEC_TRIANGLE_CEILING) throw new AuthorSpecValidationError(`author spec exceeds the ${AUTHOR_SPEC_TRIANGLE_CEILING} whole-spec triangle ceiling`);
    const part: AuthoredPart = { name: record.name, geometry };
    if ("material" in record) part.material = validateMaterial(record.material, `part ${record.name}.material`);
    if ("translate" in record) part.translate = finiteVec3(record.translate, `part ${record.name}.translate`);
    if ("rotateDegrees" in record) part.rotateDegrees = finiteVec3(record.rotateDegrees, `part ${record.name}.rotateDegrees`);
    parts.push(part);
  }
  return {
    schemaVersion: 1,
    semanticId: spec.semanticId,
    ...("parentSemanticId" in spec ? { parentSemanticId: spec.parentSemanticId as string } : {}),
    ...("kind" in spec ? { kind: spec.kind as "group" | "mesh-root" } : {}),
    ...(origin ? { origin } : {}),
    ...(material ? { material } : {}),
    parts,
  };
}

export function estimateTriangleCount(geometry: AuthoredGeometry): number {
  switch (geometry.kind) {
    case "box": return 12;
    case "cylinder": return geometry.segments * 4;
    case "tube": return geometry.segments * 4;
    case "prism": return (geometry.polygon.length - 2) * 2 + geometry.polygon.length * 2 * 3 * 2;
    case "loft": {
      const segments = geometry.rings.length - 1;
      const perRing = geometry.rings[0]!.length;
      const side = segments * perRing * 2;
      const caps = geometry.closeEnds === false ? 0 : (perRing - 2) * 2;
      return side + caps;
    }
    case "mesh": return geometry.indices.length / 3;
  }
}

export function authorSpecHash(spec: AuthorSpec): string {
  return sha256(canonicalJson(spec));
}
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

const ajv = new Ajv2020({ allErrors: true, strict: true });

export const styleContractSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://mesh2threejs.local/schemas/style-contract.v1.json",
  type: "object",
  required: ["schemaVersion", "id", "preserve", "simplify", "omit", "complexity", "appearance", "macroRelativeTolerance", "centerRelativeTolerance"],
  properties: {
    schemaVersion: { const: 1 },
    id: { const: "low-poly-faithful" },
    preserve: {
      type: "object",
      required: ["macroGeometry", "orientation", "articulation", "repeatedCounts"],
      properties: {
        macroGeometry: { const: true },
        orientation: { const: true },
        articulation: { const: true },
        repeatedCounts: { const: true },
      },
      additionalProperties: false,
    },
    simplify: { type: "array", items: { type: "string" }, minItems: 1 },
    omit: { type: "array", items: { type: "string" } },
    complexity: {
      type: "object",
      required: ["triangleTarget", "triangleMax", "meshTarget", "meshMax", "materialTarget", "materialMax", "segmentRange"],
      properties: {
        triangleTarget: { type: "integer", minimum: 1 },
        triangleMax: { type: "integer", minimum: 1 },
        meshTarget: { type: "integer", minimum: 1 },
        meshMax: { type: "integer", minimum: 1 },
        materialTarget: { type: "integer", minimum: 1 },
        materialMax: { type: "integer", minimum: 1 },
        segmentRange: { type: "array", prefixItems: [{ type: "integer", minimum: 3 }, { type: "integer", minimum: 3 }], minItems: 2, maxItems: 2 },
      },
      additionalProperties: false,
    },
    appearance: {
      type: "object",
      required: ["shading", "materialVocabulary", "texturePolicy", "palette"],
      properties: {
        shading: { const: "flat-or-faceted" },
        materialVocabulary: { const: "simple-pbr" },
        texturePolicy: { const: "none-or-generated" },
        palette: { const: "subject-derived" },
      },
      additionalProperties: false,
    },
    macroRelativeTolerance: { type: "number", minimum: 0, maximum: 0.02 },
    centerRelativeTolerance: { type: "number", minimum: 0, maximum: 0.02 },
  },
  additionalProperties: false,
} as const;

export const taskManifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://mesh2threejs.local/schemas/task-manifest.v1.json",
  type: "object",
  required: ["schemaVersion", "id", "goal", "profile", "style", "oracleManifest", "candidateModule", "certification"],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", minLength: 1, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" },
    goal: { type: "string", minLength: 1 },
    profile: { enum: ["tank", "generic"] },
    style: { type: "string", minLength: 1 },
    oracleManifest: { type: "string", minLength: 1 },
    candidateModule: { type: "string", minLength: 1 },
    certification: { enum: ["exact-real", "oracle-relative"] },
  },
  additionalProperties: false,
} as const;

export const oracleManifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://mesh2threejs.local/schemas/oracle-manifest.v1.json",
  type: "object",
  required: ["schemaVersion", "id", "sourcePath", "sourceHash", "preparedPath", "preparedHash", "source", "author", "license", "redistribution", "provenanceConfidence", "coordinateFrame", "upAxis", "forwardAxis", "grounding", "scale", "semanticStatus", "semanticMap", "articulationMap", "normalization", "authoritativeDimensions", "dimensionSources", "repairHistory"],
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", minLength: 1 },
    sourcePath: { type: "string", minLength: 1 },
    sourceHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    preparedPath: { type: "string", minLength: 1 },
    preparedHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    source: { type: "string", minLength: 1 },
    author: { type: "string", minLength: 1 },
    license: { type: "string", minLength: 1 },
    redistribution: { type: "string", minLength: 1 },
    provenanceConfidence: { enum: ["high", "medium", "low"] },
    coordinateFrame: { type: "string", minLength: 1 },
    upAxis: { type: "string", minLength: 1 },
    forwardAxis: { type: "string", minLength: 1 },
    grounding: { type: "string", minLength: 1 },
    scale: { type: "number", exclusiveMinimum: 0 },
    semanticStatus: { enum: ["reliable", "partial", "insufficient", "manual-map-required"] },
    semanticMap: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
    articulationMap: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
    normalization: {
      type: "object",
      required: ["translation", "rotationEuler", "scale"],
      properties: {
        translation: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        rotationEuler: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
        scale: { type: "number", exclusiveMinimum: 0 },
      },
      additionalProperties: false,
    },
    authoritativeDimensions: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: { type: "number", exclusiveMinimum: 0 } }] },
    dimensionSources: { type: "array", items: { type: "string" } },
    repairHistory: { type: "array", items: { type: "object" } },
  },
  additionalProperties: false,
} as const;

export const renderProfileSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://mesh2threejs.local/schemas/render-profile.v1.json",
  type: "object",
  required: ["schemaVersion", "renderer", "background", "environment", "camera", "passes"],
  properties: {
    schemaVersion: { const: "render-profile.v1" },
    renderer: { type: "object" },
    background: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
    environment: { type: "object" },
    camera: { type: "object" },
    passes: { type: "array", uniqueItems: true, minItems: 6, maxItems: 6, items: { enum: ["beauty", "alpha-silhouette", "semantic-id", "depth", "normal", "roughness-material-id"] } },
  },
  additionalProperties: false,
} as const;

const validateStyle = ajv.compile(styleContractSchema);
const validateTask = ajv.compile(taskManifestSchema);
const validateOracle = ajv.compile(oracleManifestSchema);
const validateRender = ajv.compile(renderProfileSchema);

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

function result(valid: boolean, errors: ErrorObject[] | null | undefined): ValidationResult {
  return { valid, errors: errors ? structuredClone(errors) : [] };
}

export function validateStyleContract(value: unknown): ValidationResult {
  return result(validateStyle(value), validateStyle.errors);
}

export function validateTaskManifest(value: unknown): ValidationResult {
  return result(validateTask(value), validateTask.errors);
}

export function validateOracleManifest(value: unknown): ValidationResult {
  return result(validateOracle(value), validateOracle.errors);
}

export function validateRenderProfile(value: unknown): ValidationResult {
  return result(validateRender(value), validateRender.errors);
}

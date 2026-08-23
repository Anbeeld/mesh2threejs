import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, win32 } from "node:path";
import * as THREE from "three";
import { canonicalJson, sha256 } from "./hashing.js";
import { validateOracleManifest } from "./schema.js";
import type { Bounds3, Point3 } from "../types.js";

type JsonObject = Record<string, unknown>;

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

interface ParsedGlb {
  json: JsonObject;
  binary: Buffer;
  chunks: Array<{ type: number; bytes: number }>;
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberArray(value: unknown, length: number, fallback: number[]): number[] {
  if (!Array.isArray(value) || value.length !== length || !value.every((item) => typeof item === "number")) return fallback;
  return value;
}

export function parseGlb(input: Uint8Array): ParsedGlb {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buffer.length < 12) throw new Error("GLB is shorter than its 12-byte header");
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error("GLB magic is invalid");
  if (buffer.readUInt32LE(4) !== 2) throw new Error("GLB version must be 2");
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error("GLB declared length does not match its bytes");
  let cursor = 12;
  let json: JsonObject | undefined;
  let binary = Buffer.alloc(0);
  const chunks: Array<{ type: number; bytes: number }> = [];
  while (cursor < buffer.length) {
    if (cursor + 8 > buffer.length) throw new Error("GLB chunk header is truncated");
    const bytes = buffer.readUInt32LE(cursor);
    const type = buffer.readUInt32LE(cursor + 4);
    cursor += 8;
    if (cursor + bytes > buffer.length) throw new Error("GLB chunk exceeds declared length");
    const payload = buffer.subarray(cursor, cursor + bytes);
    cursor += bytes;
    chunks.push({ type, bytes });
    if (type === JSON_CHUNK) {
      if (json) throw new Error("GLB has multiple JSON chunks");
      const parsed: unknown = JSON.parse(payload.toString("utf8").replace(/[\s\0]+$/u, ""));
      json = asObject(parsed, "GLB JSON root");
    } else if (type === BIN_CHUNK) {
      if (binary.length) throw new Error("GLB has multiple BIN chunks");
      binary = Buffer.from(payload);
    }
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, binary, chunks };
}

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readScalar(buffer: Buffer, offset: number, componentType: number): number {
  switch (componentType) {
    case 5120: return buffer.readInt8(offset);
    case 5121: return buffer.readUInt8(offset);
    case 5122: return buffer.readInt16LE(offset);
    case 5123: return buffer.readUInt16LE(offset);
    case 5125: return buffer.readUInt32LE(offset);
    case 5126: return buffer.readFloatLE(offset);
    default: throw new Error(`unsupported glTF component type ${componentType}`);
  }
}

function normalizedScalar(value: number, componentType: number): number {
  switch (componentType) {
    case 5120: return Math.max(value / 127, -1);
    case 5121: return value / 255;
    case 5122: return Math.max(value / 32767, -1);
    case 5123: return value / 65535;
    case 5125: return value / 4294967295;
    default: return value;
  }
}

function readAccessor(parsed: ParsedGlb, accessorIndex: number): { values: Float64Array; count: number; components: number; min?: number[]; max?: number[] } {
  const accessors = asArray(parsed.json.accessors);
  const accessor = asObject(accessors[accessorIndex], `accessor ${accessorIndex}`);
  const views = asArray(parsed.json.bufferViews);
  const viewIndex = accessor.bufferView;
  const componentType = Number(accessor.componentType);
  const componentBytes = COMPONENT_BYTES[componentType];
  const components = TYPE_COMPONENTS[String(accessor.type)];
  const count = Number(accessor.count);
  if (!componentBytes || !components || !Number.isInteger(count) || count < 0) throw new Error(`accessor ${accessorIndex} is invalid`);
  const accessorOffset = Number(accessor.byteOffset ?? 0);
  const values = new Float64Array(count * components);
  if (typeof viewIndex === "number") {
    const view = asObject(views[viewIndex], `bufferView ${viewIndex}`);
    if ((view.buffer ?? 0) !== 0) throw new Error("external or multi-buffer GLB is unsupported");
    const viewOffset = Number(view.byteOffset ?? 0);
    const stride = Number(view.byteStride ?? componentBytes * components);
    for (let item = 0; item < count; item += 1) {
      for (let component = 0; component < components; component += 1) {
        const offset = viewOffset + accessorOffset + item * stride + component * componentBytes;
        if (offset < 0 || offset + componentBytes > parsed.binary.length) throw new Error(`accessor ${accessorIndex} exceeds BIN chunk`);
        const raw = readScalar(parsed.binary, offset, componentType);
        values[item * components + component] = accessor.normalized === true ? normalizedScalar(raw, componentType) : raw;
      }
    }
  } else if (!accessor.sparse) throw new Error(`accessor ${accessorIndex} has neither bufferView nor sparse values`);
  if (accessor.sparse) {
    const sparse = asObject(accessor.sparse, `accessor ${accessorIndex} sparse`);
    const sparseCount = Number(sparse.count);
    const indices = asObject(sparse.indices, "sparse indices");
    const indexType = Number(indices.componentType);
    const indexBytes = COMPONENT_BYTES[indexType];
    const indexView = asObject(views[Number(indices.bufferView)], "sparse index bufferView");
    const valuesSpec = asObject(sparse.values, "sparse values");
    const valuesView = asObject(views[Number(valuesSpec.bufferView)], "sparse values bufferView");
    if (!indexBytes || ![5121, 5123, 5125].includes(indexType) || !Number.isInteger(sparseCount) || sparseCount < 0) throw new Error(`accessor ${accessorIndex} sparse metadata is invalid`);
    for (let item = 0; item < sparseCount; item += 1) {
      const indexOffset = Number(indexView.byteOffset ?? 0) + Number(indices.byteOffset ?? 0) + item * indexBytes;
      const target = readScalar(parsed.binary, indexOffset, indexType);
      if (!Number.isInteger(target) || target < 0 || target >= count) throw new Error(`accessor ${accessorIndex} sparse index is out of range`);
      for (let component = 0; component < components; component += 1) {
        const valueOffset = Number(valuesView.byteOffset ?? 0) + Number(valuesSpec.byteOffset ?? 0) + (item * components + component) * componentBytes;
        const raw = readScalar(parsed.binary, valueOffset, componentType);
        values[target * components + component] = accessor.normalized === true ? normalizedScalar(raw, componentType) : raw;
      }
    }
  }
  const min = Array.isArray(accessor.min) ? accessor.min.map(Number) : undefined;
  const max = Array.isArray(accessor.max) ? accessor.max.map(Number) : undefined;
  return { values, count, components, ...(min ? { min } : {}), ...(max ? { max } : {}) };
}

function accessorBounds(parsed: ParsedGlb, accessorIndex: number): { min: Point3; max: Point3 } {
  const accessor = readAccessor(parsed, accessorIndex);
  if (accessor.components !== 3) throw new Error("POSITION accessor must be VEC3");
  if (accessor.min?.length === 3 && accessor.max?.length === 3) {
    return { min: accessor.min as Point3, max: accessor.max as Point3 };
  }
  const min: Point3 = [Infinity, Infinity, Infinity];
  const max: Point3 = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < accessor.values.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = accessor.values[index + axis];
      if (value === undefined) continue;
      min[axis] = Math.min(min[axis] ?? value, value);
      max[axis] = Math.max(max[axis] ?? value, value);
    }
  }
  return { min, max };
}

export type SemanticReadiness = "reliable" | "partial" | "insufficient" | "manual-map-required";

export interface GlbProbe {
  schemaVersion: 1;
  kind: "glb-oracle-probe";
  sha256: string;
  bytes: number;
  asset: { version: string | null; generator: string | null };
  scene: { sceneCount: number; nodeCount: number; meshCount: number; primitiveCount: number; materialCount: number; skinCount: number; animationCount: number };
  names: string[];
  semanticIdentities: Array<{ id: string; name: string; parentId: string | null }>;
  bounds: Bounds3 | null;
  semanticReadiness: SemanticReadiness;
  warnings: string[];
}

export function probeGlb(input: Uint8Array): GlbProbe {
  const parsed = parseGlb(input);
  const meshes = asArray(parsed.json.meshes);
  const nodes = asArray(parsed.json.nodes);
  const materials = asArray(parsed.json.materials);
  const skins = asArray(parsed.json.skins);
  const animations = asArray(parsed.json.animations);
  const scenes = asArray(parsed.json.scenes);
  let primitiveCount = 0;
  const warnings: string[] = [];
  const unsupportedExtensions = asArray(parsed.json.extensionsRequired).filter((value): value is string => typeof value === "string" && ["KHR_draco_mesh_compression", "EXT_meshopt_compression"].includes(value));
  if (unsupportedExtensions.length) throw new Error(`unsupported required glTF geometry extension: ${unsupportedExtensions.join(", ")}`);
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex += 1) {
    const mesh = asObject(meshes[meshIndex], `mesh ${meshIndex}`);
    const primitives = asArray(mesh.primitives);
    primitiveCount += primitives.length;
    for (let primitiveIndex = 0; primitiveIndex < primitives.length; primitiveIndex += 1) {
      const primitive = asObject(primitives[primitiveIndex], `mesh ${meshIndex} primitive ${primitiveIndex}`);
      const attributes = asObject(primitive.attributes, "primitive attributes");
      if (typeof attributes.POSITION !== "number") {
        warnings.push(`mesh ${meshIndex} primitive ${primitiveIndex} has no POSITION`);
        continue;
      }
      accessorBounds(parsed, attributes.POSITION);
    }
  }
  const sceneRoot = meshes.length ? loadGlbScene(input) : null;
  const worldBox = sceneRoot ? new THREE.Box3().setFromObject(sceneRoot) : null;
  const bounds = worldBox && !worldBox.isEmpty() ? { min: [worldBox.min.x, worldBox.min.y, worldBox.min.z] as Point3, max: [worldBox.max.x, worldBox.max.y, worldBox.max.z] as Point3, size: [worldBox.max.x - worldBox.min.x, worldBox.max.y - worldBox.min.y, worldBox.max.z - worldBox.min.z] as Point3, center: [(worldBox.min.x + worldBox.max.x) / 2, (worldBox.min.y + worldBox.max.y) / 2, (worldBox.min.z + worldBox.max.z) / 2] as Point3 } : null;
  const names = [...nodes, ...meshes].map((item, index) => {
    const object = asObject(item, `named glTF item ${index}`);
    return typeof object.name === "string" ? object.name : "";
  }).filter(Boolean);
  const semanticIdentities = nodes.map((item, index) => {
    const node = asObject(item, `node ${index}`);
    const parentIndex = nodes.findIndex((parent) => asArray(asObject(parent, "node").children).includes(index));
    return { id: `node:${index}`, name: typeof node.name === "string" ? node.name : `node-${index}`, parentId: parentIndex >= 0 ? `node:${parentIndex}` : null };
  });
  const meaningfulNames = names.filter((name) => !/^(object|mesh|node)[_-]?\d*$/iu.test(name));
  let semanticReadiness: SemanticReadiness;
  if (meshes.length === 1 && nodes.length <= 1) semanticReadiness = "insufficient";
  else if (!meaningfulNames.length) semanticReadiness = "manual-map-required";
  else if (meshes.length >= 2 && meaningfulNames.length >= 2) semanticReadiness = "reliable";
  else semanticReadiness = "partial";
  if (!materials.length) warnings.push("GLB has no materials");
  if (skins.length) warnings.push("skins are inventoried but static preparation does not reproduce skin deformation");
  if (animations.length) warnings.push("animations are inventoried but static preparation does not reproduce animation clips");
  const asset = parsed.json.asset && typeof parsed.json.asset === "object" ? parsed.json.asset as JsonObject : {};
  return {
    schemaVersion: 1,
    kind: "glb-oracle-probe",
    sha256: sha256(input),
    bytes: input.byteLength,
    asset: {
      version: typeof asset.version === "string" ? asset.version : null,
      generator: typeof asset.generator === "string" ? asset.generator : null,
    },
    scene: {
      sceneCount: scenes.length,
      nodeCount: nodes.length,
      meshCount: meshes.length,
      primitiveCount,
      materialCount: materials.length,
      skinCount: skins.length,
      animationCount: animations.length,
    },
    names,
    semanticIdentities,
    bounds,
    semanticReadiness,
    warnings,
  };
}

function buildPrimitive(parsed: ParsedGlb, primitiveValue: unknown, name: string, materialValues: unknown[]): THREE.Mesh {
  const primitive = asObject(primitiveValue, "primitive");
  if (primitive.mode !== undefined && primitive.mode !== 4) throw new Error("only glTF TRIANGLES primitives are supported");
  const attributes = asObject(primitive.attributes, "primitive attributes");
  if (typeof attributes.POSITION !== "number") throw new Error("primitive has no POSITION accessor");
  const positions = readAccessor(parsed, attributes.POSITION);
  if (positions.components !== 3) throw new Error("POSITION accessor must be VEC3");
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(positions.values), 3));
  if (typeof attributes.NORMAL === "number") {
    const normals = readAccessor(parsed, attributes.NORMAL);
    if (normals.components === 3) geometry.setAttribute("normal", new THREE.BufferAttribute(Float32Array.from(normals.values), 3));
  }
  if (typeof primitive.indices === "number") {
    const indices = readAccessor(parsed, primitive.indices);
    geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(indices.values), 1));
  }
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const materialValue = typeof primitive.material === "number" ? materialValues[primitive.material] : undefined;
  const materialObject = materialValue && typeof materialValue === "object" ? materialValue as JsonObject : {};
  const pbr = materialObject.pbrMetallicRoughness && typeof materialObject.pbrMetallicRoughness === "object"
    ? materialObject.pbrMetallicRoughness as JsonObject
    : {};
  const color = numberArray(pbr.baseColorFactor, 4, [0.5, 0.5, 0.5, 1]);
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color[0] ?? 0.5, color[1] ?? 0.5, color[2] ?? 0.5),
    roughness: typeof pbr.roughnessFactor === "number" ? pbr.roughnessFactor : 0.7,
    metalness: typeof pbr.metallicFactor === "number" ? pbr.metallicFactor : 0,
  });
  material.name = typeof materialObject.name === "string" ? materialObject.name : "oracle-material";
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  return mesh;
}

export function loadGlbScene(input: Uint8Array): THREE.Group {
  const parsed = parseGlb(input);
  const meshValues = asArray(parsed.json.meshes);
  const nodeValues = asArray(parsed.json.nodes);
  const materialValues = asArray(parsed.json.materials);
  const nodeObjects = nodeValues.map((nodeValue, nodeIndex) => {
    const node = asObject(nodeValue, `node ${nodeIndex}`);
    const group = new THREE.Group();
    group.name = typeof node.name === "string" ? node.name : `node-${nodeIndex}`;
    group.userData.oracleNodeId = `node:${nodeIndex}`;
    if (typeof node.mesh === "number") {
      const mesh = asObject(meshValues[node.mesh], `mesh ${node.mesh}`);
      const primitives = asArray(mesh.primitives);
      primitives.forEach((primitive, primitiveIndex) => {
        const child = buildPrimitive(parsed, primitive, primitives.length === 1 ? group.name : `${group.name}-${primitiveIndex}`, materialValues);
        group.add(child);
      });
    }
    const matrix = numberArray(node.matrix, 16, []);
    if (matrix.length === 16) {
      group.matrix.fromArray(matrix);
      group.matrix.decompose(group.position, group.quaternion, group.scale);
    } else {
      group.position.fromArray(numberArray(node.translation, 3, [0, 0, 0]));
      group.quaternion.fromArray(numberArray(node.rotation, 4, [0, 0, 0, 1]));
      group.scale.fromArray(numberArray(node.scale, 3, [1, 1, 1]));
    }
    return group;
  });
  nodeValues.forEach((nodeValue, nodeIndex) => {
    const node = asObject(nodeValue, `node ${nodeIndex}`);
    for (const childIndex of asArray(node.children)) {
      if (typeof childIndex === "number" && nodeObjects[childIndex]) nodeObjects[nodeIndex]?.add(nodeObjects[childIndex]);
    }
  });
  const root = new THREE.Group();
  root.name = "prepared-oracle-source";
  const scenes = asArray(parsed.json.scenes);
  const sceneIndex = typeof parsed.json.scene === "number" ? parsed.json.scene : 0;
  const scene = scenes[sceneIndex] ? asObject(scenes[sceneIndex], `scene ${sceneIndex}`) : {};
  const roots = asArray(scene.nodes).filter((value): value is number => typeof value === "number");
  if (roots.length) roots.forEach((index) => { if (nodeObjects[index]) root.add(nodeObjects[index]); });
  else nodeObjects.filter((object) => !object.parent).forEach((object) => root.add(object));
  root.updateMatrixWorld(true);
  return root;
}

/**
 * Canonical identity of the complete authoritative preparation record. It changes whenever any
 * decision-changing preparation input changes: selected reference, source bytes, prepared recipe,
 * semantic/articulation mapping, normalization, repair lineage, or admitted dimensions.
 */
export function oraclePreparationIdentity(manifest: OracleManifest): string {
  if (manifest.schemaVersion !== 1) throw new Error("oracle manifest schema is unsupported");
  const { schemaVersion: _schemaVersion, ...record } = manifest;
  return sha256(canonicalJson(record));
}

export interface OraclePreparationBinding {
  identity: string;
  sourceHash: string;
  preparedHash: string;
}

export function oraclePreparationBinding(manifest: OracleManifest): OraclePreparationBinding {
  return { identity: oraclePreparationIdentity(manifest), sourceHash: manifest.sourceHash, preparedHash: manifest.preparedHash };
}

export interface OracleManifest {
  schemaVersion: 1;
  id: string;
  sourcePath: string;
  sourceHash: string;
  preparedPath: string;
  preparedHash: string;
  sourceOriginalPath: string;
  referenceMode: "copy" | "external";
  portable: boolean;
  source: string;
  author: string;
  license: string;
  redistribution: string;
  provenanceConfidence: "high" | "medium" | "low";
  coordinateFrame: string;
  upAxis: string;
  forwardAxis: string;
  grounding: string;
  scale: number;
  semanticStatus: SemanticReadiness;
  semanticMap: Record<string, string>;
  articulationMap: Record<string, string>;
  normalization: { translation: Point3; rotationEuler: Point3; scale: number };
  sourceFrame?: { up: string; forward: string; right: string };
  logicalOwnership?: Record<string, string>;
  authoritativeDimensions: Record<string, number> | null;
  dimensionSources: string[];
  repairHistory: Array<{ reason: string; recipeHash: string }>;
}

export interface OnboardOracleInput extends Omit<OracleManifest, "schemaVersion" | "sourceHash" | "preparedHash" | "sourceOriginalPath" | "referenceMode" | "portable" | "semanticStatus" | "provenanceConfidence" | "repairHistory"> {
  provenanceConfidence?: "high" | "medium" | "low";
  workspaceRoot?: string;
  sourceOriginalPath?: string;
  referenceMode?: "copy" | "external";
  sourceFrame?: { up: string; forward: string; right: string };
  logicalOwnership?: Record<string, string>;
}

interface PreparedRecipe {
  schemaVersion: 1;
  kind: "prepared-oracle-recipe";
  parentSourceHash: string;
  sourcePath: string;
  semanticMap: Record<string, string>;
  articulationMap: Record<string, string>;
  normalization: { translation: Point3; rotationEuler: Point3; scale: number };
  sourceFrame?: { up: string; forward: string; right: string };
  logicalOwnership?: Record<string, string>;
  repair?: { parentPreparedHash: string; reason: string };
  preparedHash?: string;
}

function workspaceFile(path: string, workspaceRoot: string | undefined, label: string): string {
  if (isAbsolute(path)) return resolve(path);
  if (!workspaceRoot) throw new Error(`${label} is workspace-relative but no workspace root was provided`);
  const root = resolve(workspaceRoot);
  const target = resolve(root, path);
  const relation = relative(root, target);
  if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relation)) throw new Error(`${label} escapes workspace root`);
  return target;
}

function storedPath(path: string, workspaceRoot: string | undefined): string {
  return workspaceRoot && !isAbsolute(path) ? path.replaceAll("\\", "/") : resolve(path);
}

/** Recorded lineage paths may originate on another platform; only relative paths are resolved against this host. */
function recordedOriginalPath(path: string): string {
  return isAbsolute(path) || win32.isAbsolute(path) ? path : resolve(path);
}

export async function onboardOracle(input: OnboardOracleInput): Promise<OracleManifest> {
  const referenceMode = input.referenceMode ?? (isAbsolute(input.sourcePath) ? "external" : "copy");
  if (referenceMode === "copy" && isAbsolute(input.sourcePath)) throw new Error("copy-mode oracle sourcePath must be workspace-relative");
  if (referenceMode === "external" && !isAbsolute(input.sourcePath)) throw new Error("external oracle sourcePath must be absolute");
  const sourceFile = workspaceFile(input.sourcePath, input.workspaceRoot, "oracle sourcePath");
  const preparedFile = workspaceFile(input.preparedPath, input.workspaceRoot, "preparedPath");
  const sourcePath = storedPath(input.sourcePath, input.workspaceRoot);
  const preparedPath = storedPath(input.preparedPath, input.workspaceRoot);
  const bytes = await readFile(sourceFile);
  const probe = probeGlb(bytes);
  const sourceHash = sha256(bytes);
  if (input.logicalOwnership) {
    for (const [child, parent] of Object.entries(input.logicalOwnership)) {
      if (child === parent) throw new Error(`ownership cycle: ${child} owns itself`);
      if (child === "hull" && parent === "turret-pivot") throw new Error("hull cannot be owned by turret-pivot");
      if (child.startsWith("track-") && parent === "gun-pivot") throw new Error("track cannot be owned by gun-pivot");
    }
    const seen = new Set<string>();
    for (const parent of Object.values(input.logicalOwnership)) {
      if (seen.has(parent) && input.logicalOwnership[parent]) { /* allow */ }
      const chain = new Set<string>();
      let cur: string | undefined = parent;
      while (cur && input.logicalOwnership[cur]) { if (chain.has(cur)) throw new Error(`ownership cycle includes ${cur}`); chain.add(cur); cur = input.logicalOwnership[cur]; }
    }
    for (const p of Object.values(input.logicalOwnership)) if (!input.semanticMap[p] && !Object.values(input.semanticMap).includes(p) && p !== "root" && p !== "turret-pivot" && p !== "gun-pivot") throw new Error(`missing pivot ${p}`);
  }
  const baseRecipe: PreparedRecipe = {
    schemaVersion: 1,
    kind: "prepared-oracle-recipe",
    parentSourceHash: sourceHash,
    sourcePath,
    semanticMap: input.semanticMap,
    articulationMap: input.articulationMap,
    normalization: input.normalization,
    ...(input.sourceFrame ? { sourceFrame: input.sourceFrame } : {}),
    ...(input.logicalOwnership ? { logicalOwnership: input.logicalOwnership } : {}),
  };
  const preparedHash = sha256(canonicalJson(baseRecipe));
  await mkdir(dirname(preparedFile), { recursive: true });
  await writeFile(preparedFile, `${JSON.stringify({ ...baseRecipe, preparedHash }, null, 2)}\n`, { flag: "wx" });
  return {
    schemaVersion: 1,
    id: input.id,
    sourcePath,
    sourceHash,
    preparedPath,
    preparedHash,
    sourceOriginalPath: input.sourceOriginalPath ? recordedOriginalPath(input.sourceOriginalPath) : sourceFile,
    referenceMode,
    portable: referenceMode === "copy",
    source: input.source,
    author: input.author,
    license: input.license,
    redistribution: input.redistribution,
    provenanceConfidence: input.provenanceConfidence ?? "medium",
    coordinateFrame: input.coordinateFrame,
    upAxis: input.upAxis,
    forwardAxis: input.forwardAxis,
    grounding: input.grounding,
    scale: input.scale,
    semanticStatus: Object.keys(input.semanticMap).length ? (probe.semanticReadiness === "insufficient" ? "partial" : probe.semanticReadiness) : probe.semanticReadiness,
    semanticMap: input.semanticMap,
    articulationMap: input.articulationMap,
    normalization: input.normalization,
    ...(input.sourceFrame ? { sourceFrame: input.sourceFrame } : {}),
    ...(input.logicalOwnership ? { logicalOwnership: input.logicalOwnership } : {}),
    authoritativeDimensions: input.authoritativeDimensions,
    dimensionSources: input.dimensionSources,
    repairHistory: [],
  };
}

async function readVerifiedRecipe(manifest: OracleManifest, workspaceRoot?: string): Promise<PreparedRecipe> {
  let recipeValue: unknown;
  try {
    recipeValue = JSON.parse(await readFile(workspaceFile(manifest.preparedPath, workspaceRoot, "preparedPath"), "utf8"));
  } catch (error) {
    throw new Error(`prepared oracle recipe is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const recipe = asObject(recipeValue, "prepared oracle recipe") as unknown as PreparedRecipe;
  const { preparedHash: sealedHash, ...baseRecipe } = recipe;
  if (recipe.parentSourceHash !== manifest.sourceHash || recipe.sourcePath !== manifest.sourcePath || sha256(canonicalJson(baseRecipe)) !== manifest.preparedHash || sealedHash !== manifest.preparedHash) {
    throw new Error("prepared oracle lineage/hash mismatch");
  }
  return recipe;
}

async function readVerifiedSourceBytes(manifest: OracleManifest, workspaceRoot?: string): Promise<Buffer> {
  const sourceBytes = await readFile(workspaceFile(manifest.sourcePath, workspaceRoot, "oracle sourcePath"));
  if (sha256(sourceBytes) !== manifest.sourceHash) throw new Error("immutable source oracle bytes changed");
  return sourceBytes;
}

/**
 * Verifies the live preparation end to end: manifest schema, prepared recipe lineage against the
 * manifest hashes, and immutable source bytes — then returns the canonical preparation binding.
 * Every authority boundary uses this one verifier so no command grows its own partial check.
 */
export async function verifyOraclePreparation(manifest: OracleManifest, workspaceRoot?: string): Promise<OraclePreparationBinding> {
  if (!validateOracleManifest(manifest).valid) throw new Error("oracle manifest schema is invalid");
  await readVerifiedRecipe(manifest, workspaceRoot);
  await readVerifiedSourceBytes(manifest, workspaceRoot);
  return oraclePreparationBinding(manifest);
}

export async function loadPreparedOracle(manifest: OracleManifest, workspaceRoot?: string): Promise<THREE.Group> {
  const recipe = await readVerifiedRecipe(manifest, workspaceRoot);
  const sourceBytes = await readVerifiedSourceBytes(manifest, workspaceRoot);
  const source = loadGlbScene(sourceBytes);
  const nameCounts = new Map<string, number>();
  source.traverse((object) => nameCounts.set(object.name, (nameCounts.get(object.name) ?? 0) + 1));
  source.traverse((object) => {
    const stableId = typeof object.userData.oracleNodeId === "string" ? object.userData.oracleNodeId : undefined;
    if ((nameCounts.get(object.name) ?? 0) > 1 && recipe.semanticMap[object.name]) throw new Error(`ambiguous semantic map key ${object.name}; use stable node:N identity`);
    const semantic = (stableId ? recipe.semanticMap[stableId] : undefined) ?? recipe.semanticMap[object.name];
    if (semantic) object.userData.semanticId = semantic;
    const articulationPivot = recipe.articulationMap[object.name] ?? (semantic ? recipe.articulationMap[semantic] : undefined);
    if (articulationPivot) object.userData.articulationPivot = articulationPivot;
    if (semantic && recipe.logicalOwnership?.[semantic]) object.userData.logicalOwner = recipe.logicalOwnership[semantic];
  });
  const frame = new THREE.Group();
  frame.name = "prepared-oracle-normalization-frame";
  frame.position.set(...recipe.normalization.translation);
  frame.rotation.set(...recipe.normalization.rotationEuler);
  frame.add(source);
  const root = new THREE.Group();
  root.name = manifest.id;
  root.scale.setScalar(recipe.normalization.scale);
  root.userData.forwardAxis = manifest.forwardAxis;
  root.userData.upAxis = manifest.upAxis;
  root.add(frame);
  root.updateMatrixWorld(true);
  return root;
}

export interface RepairPreparedOracleInput {
  reason: string;
  preparedPath: string;
  semanticMap?: Record<string, string>;
  articulationMap?: Record<string, string>;
  normalization?: { translation: Point3; rotationEuler: Point3; scale: number };
}

export async function repairPreparedOracle(manifest: OracleManifest, input: RepairPreparedOracleInput, workspaceRoot?: string): Promise<OracleManifest> {
  if (!input.reason.trim()) throw new Error("oracle repair requires a reason");
  await verifyOraclePreparation(manifest, workspaceRoot);
  const preparedFile = workspaceFile(input.preparedPath, workspaceRoot, "preparedPath");
  const preparedPath = storedPath(input.preparedPath, workspaceRoot);
  const baseRecipe: Omit<PreparedRecipe, "preparedHash"> = {
    schemaVersion: 1,
    kind: "prepared-oracle-recipe",
    parentSourceHash: manifest.sourceHash,
    sourcePath: manifest.sourcePath,
    semanticMap: input.semanticMap ?? manifest.semanticMap,
    articulationMap: input.articulationMap ?? manifest.articulationMap,
    normalization: input.normalization ?? manifest.normalization,
    repair: { parentPreparedHash: manifest.preparedHash, reason: input.reason.trim() },
  };
  const preparedHash = sha256(canonicalJson(baseRecipe));
  await mkdir(dirname(preparedFile), { recursive: true });
  await writeFile(preparedFile, `${JSON.stringify({ ...baseRecipe, preparedHash }, null, 2)}\n`, { flag: "wx" });
  return {
    ...manifest,
    preparedPath,
    preparedHash,
    semanticMap: baseRecipe.semanticMap,
    articulationMap: baseRecipe.articulationMap,
    normalization: baseRecipe.normalization,
    repairHistory: [...manifest.repairHistory, { reason: input.reason.trim(), recipeHash: preparedHash }],
  };
}

export interface RegistrationExpectation {
  forwardAxis: string;
  upAxis: string;
  expectedScale: number;
  groundY: number;
  requiredSemantics: string[];
  requiredPivots: string[];
  tolerance: number;
}

export interface RegistrationEvidence {
  schemaVersion: 1;
  kind: "oracle-registration";
  passed: boolean;
  rows: Array<{ code: string; passed: boolean; expected: string | number; actual: string | number }>;
}

export function verifyOracleRegistration(root: THREE.Object3D, expected: RegistrationExpectation): RegistrationEvidence {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  const semantics = new Set<string>();
  const names = new Set<string>();
  const pivots = new Set<string>();
  const semanticObjects: THREE.Object3D[] = [];
  root.traverse((object) => {
    names.add(object.name);
    if (typeof object.userData.semanticId === "string") { semantics.add(object.userData.semanticId); semanticObjects.push(object); }
    if (typeof object.userData.articulationPivot === "string") pivots.add(object.userData.articulationPivot);
  });
  const uniformScale = root.scale.x;
  const rows: RegistrationEvidence["rows"] = [
    { code: "registration.forward", passed: root.userData.forwardAxis === expected.forwardAxis, expected: expected.forwardAxis, actual: String(root.userData.forwardAxis ?? "missing") },
    { code: "registration.up", passed: root.userData.upAxis === expected.upAxis, expected: expected.upAxis, actual: String(root.userData.upAxis ?? "missing") },
    { code: "registration.scale", passed: Math.abs(uniformScale - expected.expectedScale) <= expected.tolerance && Math.abs(root.scale.y - uniformScale) <= expected.tolerance && Math.abs(root.scale.z - uniformScale) <= expected.tolerance, expected: expected.expectedScale, actual: uniformScale },
    { code: "registration.ground", passed: Math.abs(bounds.min.y - expected.groundY) <= expected.tolerance, expected: expected.groundY, actual: bounds.min.y },
    ...expected.requiredSemantics.map((semantic) => ({ code: `registration.semantic.${semantic}`, passed: semantics.has(semantic), expected: "present", actual: semantics.has(semantic) ? "present" : "missing" })),
    ...expected.requiredPivots.map((pivot) => ({ code: `registration.pivot.${pivot}`, passed: names.has(pivot) || pivots.has(pivot), expected: "present", actual: names.has(pivot) || pivots.has(pivot) ? "present" : "missing" })),
  ];
  try {
    const roadWheels = semanticObjects.filter((o) => o.userData.semanticId?.startsWith("road-wheel"));
    if (roadWheels.length >= 4) {
      const zs = roadWheels.map((o) => { const p = new THREE.Vector3(); o.getWorldPosition(p); return p.z; });
      const xs = roadWheels.map((o) => { const p = new THREE.Vector3(); o.getWorldPosition(p); return p.x; });
      const zVar = Math.max(...zs) - Math.min(...zs);
      const xVar = Math.max(...xs) - Math.min(...xs);
      const longitudinalOk = zVar > xVar * 1.5;
      rows.push({ code: "registration.frame.longitudinal", passed: longitudinalOk, expected: "Z variance >> X variance", actual: `zVar ${zVar.toFixed(2)} xVar ${xVar.toFixed(2)}` });
      const left = roadWheels.filter((o) => { const p = new THREE.Vector3(); o.getWorldPosition(p); return p.x < 0; }).length;
      const right = roadWheels.filter((o) => { const p = new THREE.Vector3(); o.getWorldPosition(p); return p.x > 0; }).length;
      rows.push({ code: "registration.frame.lateral", passed: left > 0 && right > 0, expected: "left+right wheels separated on X", actual: `L${left} R${right}` });
      const groundY = bounds.min.y;
      const wheelYs = roadWheels.map((o) => { const p = new THREE.Vector3(); o.getWorldPosition(p); return p.y; });
      const nearGround = wheelYs.every((y) => Math.abs(y - groundY) < 1.5);
      rows.push({ code: "registration.frame.ground-contact", passed: nearGround, expected: "wheels near ground", actual: nearGround ? "near ground" : "elevated" });
    }
  } catch {}
  return { schemaVersion: 1, kind: "oracle-registration", passed: rows.every((row) => row.passed), rows };
}

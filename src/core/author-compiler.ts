import * as THREE from "three";
import { canonicalJson, sha256 } from "./hashing.js";
import { AUTHORED_COMPILER_VERSION, estimateTriangleCount, type AuthoredGeometry, type AuthoredPart, type AuthorSpec, type Vec3 } from "./author-spec.js";
import { ConstructionRoutingError } from "./construction-mode.js";
/**
 * Trusted authored geometry compiler (stylized-authored mode design §9/§10/§28). The compiler
 * is trusted package code: builder-authored AuthorSpec JSON is DATA, and this module is the
 * ONLY component that turns it into candidate geometry. It receives no oracle object, no
 * reference scene, and no source-derived geometry of any kind — every output triangle is
 * generated from the spec. Compilation is deterministic: identical spec bytes produce
 * identical module bytes and hashes.
 */

export interface CompiledGeometry {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface CompiledPartGeometry {
  name: string;
  geometry: CompiledGeometry;
  material: ResolvedMaterial;
}

export interface ResolvedMaterial {
  /** Working (linear) color after deterministic sRGB conversion. */
  colorLinear: [number, number, number];
  roughness: number;
  metalness: number;
  flatShading: boolean;
}

const DEFAULT_MATERIAL: ResolvedMaterial = { colorLinear: [0.0265, 0.0225, 0.0028], roughness: 0.8, metalness: 0, flatShading: true };

/** Deterministic sRGB -> linear conversion (design §28.3): the spec declares sRGB, the compiler converts. */
export function srgbToLinear(channel: number): number {
  if (channel <= 0.04045) return channel / 12.92;
  return Math.pow((channel + 0.055) / 1.055, 2.4);
}

function resolveMaterial(part: AuthoredPart, spec: AuthorSpec): ResolvedMaterial {
  const material = part.material ?? spec.material ?? { colorSpace: "srgb" as const, color: [0.18, 0.16, 0.07] as Vec3 };
  return {
    colorLinear: [
      Number(srgbToLinear(material.color[0]).toFixed(6)),
      Number(srgbToLinear(material.color[1]).toFixed(6)),
      Number(srgbToLinear(material.color[2]).toFixed(6)),
    ],
    roughness: material.roughness ?? DEFAULT_MATERIAL.roughness,
    metalness: material.metalness ?? DEFAULT_MATERIAL.metalness,
    flatShading: material.flatShading ?? true,
  };
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function applyPartTransform(positions: Float32Array, part: AuthoredPart): Float32Array {
  const translate = part.translate ?? [0, 0, 0];
  const rotate = part.rotateDegrees ?? [0, 0, 0];
  if (translate.every((axis) => axis === 0) && rotate.every((axis) => axis === 0)) return positions;
  const count = positions.length / 3;
  const center: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < count; index += 1) {
    center[0] += positions[index * 3]! / count;
    center[1] += positions[index * 3 + 1]! / count;
    center[2] += positions[index * 3 + 2]! / count;
  }
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    (rotate[0] * Math.PI) / 180,
    (rotate[1] * Math.PI) / 180,
    (rotate[2] * Math.PI) / 180,
  ));
  const vector = new THREE.Vector3();
  const output = new Float32Array(positions.length);
  for (let index = 0; index < count; index += 1) {
    vector.set(positions[index * 3]! - center[0], positions[index * 3 + 1]! - center[1], positions[index * 3 + 2]! - center[2]).applyQuaternion(quaternion);
    output[index * 3] = round(vector.x + center[0] + translate[0]);
    output[index * 3 + 1] = round(vector.y + center[1] + translate[1]);
    output[index * 3 + 2] = round(vector.z + center[2] + translate[2]);
  }
  return output;
}

function indexedFromGeometry(geometry: THREE.BufferGeometry): CompiledGeometry {
  const indexed = geometry.index ? geometry.toNonIndexed() : geometry;
  const positions = Float32Array.from(indexed.getAttribute("position").array as Float32Array);
  const vertexCount = positions.length / 3;
  const indices = new Uint32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) indices[index] = index;
  geometry.dispose();
  indexed.dispose();
  return { positions, indices };
}

function compileBox(size: Vec3): CompiledGeometry {
  return indexedFromGeometry(new THREE.BoxGeometry(size[0], size[1], size[2]));
}

function compileCylinder(radius: number, height: number, segments: number, axis: "x" | "y" | "z"): CompiledGeometry {
  const geometry = new THREE.CylinderGeometry(radius, radius, height, segments, 1, false);
  if (axis === "x") geometry.rotateZ(Math.PI / 2);
  else if (axis === "z") geometry.rotateX(Math.PI / 2);
  return indexedFromGeometry(geometry);
}

function compileTube(from: Vec3, to: Vec3, radius: number, segments: number): CompiledGeometry {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const direction = end.clone().sub(start);
  const length = Math.max(direction.length(), 1e-9);
  const geometry = new THREE.CylinderGeometry(radius, radius, length, segments, 1, false);
  geometry.translate(0, length / 2, 0);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
  geometry.translate(start.x, start.y, start.z);
  return indexedFromGeometry(geometry);
}

/**
 * Deterministic fan-triangulated prism: an authored 2D polygon extruded along one axis from
 * 0 to `extrude`. Authored polygons are deliberately simple; the fan keeps compilation fully
 * deterministic with no triangulation-library drift.
 */
function compilePrism(polygon: Array<[number, number]>, extrude: number, axis: "x" | "y" | "z"): CompiledGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const pointCount = polygon.length;
  const push = (x: number, y: number, z: number): number => {
    positions.push(round(x), round(y), round(z));
    return positions.length / 3 - 1;
  };
  const mapPoint = (u: number, v: number, along: number): [number, number, number] => {
    if (axis === "y") return [u, along, v];
    if (axis === "z") return [u, v, along];
    return [along, u, v];
  };
  const bottom = polygon.map(([u, v]) => push(...mapPoint(u, v, 0)));
  const top = polygon.map(([u, v]) => push(...mapPoint(u, v, extrude)));
  for (let index = 1; index < pointCount - 1; index += 1) {
    indices.push(bottom[0]!, bottom[index]!, bottom[index + 1]!);
    indices.push(top[0]!, top[index + 1]!, top[index]!);
  }
  for (let index = 0; index < pointCount; index += 1) {
    const next = (index + 1) % pointCount;
    indices.push(bottom[index]!, top[index]!, top[next]!);
    indices.push(bottom[index]!, top[next]!, bottom[next]!);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

function compileLoft(rings: Vec3[][], closeEnds: boolean): CompiledGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const ring of rings) for (const vertex of ring) positions.push(round(vertex[0]), round(vertex[1]), round(vertex[2]));
  const perRing = rings[0]!.length;
  const ringAt = (ring: number, vertex: number): number => ring * perRing + (vertex % perRing);
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    for (let vertex = 0; vertex < perRing; vertex += 1) {
      const a = ringAt(ring, vertex);
      const b = ringAt(ring, vertex + 1);
      const c = ringAt(ring + 1, vertex + 1);
      const d = ringAt(ring + 1, vertex);
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }
  if (closeEnds) {
    const firstRing = 0;
    for (let vertex = 1; vertex < perRing - 1; vertex += 1) {
      indices.push(ringAt(firstRing, 0), ringAt(firstRing, vertex), ringAt(firstRing, vertex + 1));
    }
    const lastRing = rings.length - 1;
    for (let vertex = 1; vertex < perRing - 1; vertex += 1) {
      indices.push(ringAt(lastRing, 0), ringAt(lastRing, vertex + 1), ringAt(lastRing, vertex));
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

function compileAuthoredMesh(positions: number[], indices: number[]): CompiledGeometry {
  return { positions: Float32Array.from(positions.map(round)), indices: Uint32Array.from(indices) };
}

export function compileGeometry(geometry: AuthoredGeometry): CompiledGeometry {
  switch (geometry.kind) {
    case "box": return compileBox(geometry.size);
    case "cylinder": return compileCylinder(geometry.radius, geometry.height, geometry.segments, geometry.axis ?? "y");
    case "tube": return compileTube(geometry.from, geometry.to, geometry.radius, geometry.segments);
    case "prism": return compilePrism(geometry.polygon, geometry.extrude, geometry.axis ?? "y");
    case "loft": return compileLoft(geometry.rings, geometry.closeEnds ?? true);
    case "mesh": return compileAuthoredMesh(geometry.positions, geometry.indices);
  }
}

export interface CompiledAuthorSpec {
  spec: AuthorSpec;
  specHash: string;
  parts: CompiledPartGeometry[];
  triangleCount: number;
  vertexCount: number;
  geometryHash: string;
  materialHash: string;
}

/** Compiles one validated AuthorSpec into deterministic semantic-local geometry. */
export function compileAuthorSpec(spec: AuthorSpec): CompiledAuthorSpec {
  if ((spec.kind ?? "mesh-root") === "group" && spec.parts.length) {
    throw new ConstructionRoutingError("AUTHOR_SPEC_INVALID", `pivot semantic ${spec.semanticId} must be a transform-only group (triangle count 0, design §28.2)`);
  }
  const parts: CompiledPartGeometry[] = [];
  const materialHashes: string[] = [];
  for (const part of spec.parts) {
    const compiled = compileGeometry(part.geometry);
    const transformed = applyPartTransform(compiled.positions, part);
    const material = resolveMaterial(part, spec);
    parts.push({ name: part.name, geometry: { positions: transformed, indices: compiled.indices }, material });
    materialHashes.push(canonicalJson(material));
  }
  const hash = new (require("node:crypto").Hash ?? Object)("sha256");
  void hash;
  const allPositions = new Float32Array(parts.reduce((sum, part) => sum + part.geometry.positions.length, 0));
  const allIndices = new Uint32Array(parts.reduce((sum, part) => sum + part.geometry.indices.length, 0));
  let positionOffset = 0;
  let indexOffset = 0;
  let indexBase = 0;
  for (const part of parts) {
    allPositions.set(part.geometry.positions, positionOffset);
    for (let index = 0; index < part.geometry.indices.length; index += 1) allIndices[indexOffset + index] = part.geometry.indices[index]! + indexBase;
    positionOffset += part.geometry.positions.length;
    indexOffset += part.geometry.indices.length;
    indexBase += part.geometry.positions.length / 3;
  }
  const geometryHash = geometryContentHash(allPositions, allIndices);
  return {
    spec,
    specHash: sha256(canonicalJson(spec)),
    parts,
    triangleCount: spec.parts.reduce((sum, part) => sum + estimateTriangleCount(part.geometry), 0),
    vertexCount: allPositions.length / 3,
    geometryHash,
    materialHash: sha256(canonicalJson(materialHashes)),
  };
}

function geometryContentHash(positions: Float32Array, indices: Uint32Array): string {
  const rounded = canonicalJson({
    positions: Array.from(positions, (value) => Number(value.toFixed(6))),
    indices: Array.from(indices),
  });
  return sha256(rounded);
}

function roundList(values: Float32Array | number[]): string {
  return Array.from(values, (value) => Number(value.toFixed(6)).toString()).join(",");
}

/**
 * Emits the trusted generated module for one compiled authored semantic. Mirrors the derived
 * module shape (createSeed export, semantic-attributed group) so the existing candidate
 * executor, snapshot attribution, articulation controls, and evaluator work unchanged.
 */
export function emitAuthoredModule(compiled: CompiledAuthorSpec): string {
  const spec = compiled.spec;
  const lines: string[] = [];
  lines.push(`import * as THREE from "three";`);
  lines.push(``);
  lines.push(`// Generated by mesh2threejs author-compiler ${AUTHORED_COMPILER_VERSION} — trusted pipeline output.`);
  lines.push(`// Authored from AuthorSpec ${compiled.specHash.slice(0, 16)}… (semantic ${spec.semanticId}). Do not edit by hand.`);
  compiled.parts.forEach((part, index) => {
    lines.push(`const P${index} = new Float32Array([${roundList(part.geometry.positions)}]);`);
    lines.push(`const I${index} = new Uint32Array([${Array.from(part.geometry.indices).join(",")}]);`);
  });
  lines.push(``);
  lines.push(`export function createSeed() {`);
  lines.push(`  const group = new THREE.Group();`);
  lines.push(`  group.name = ${JSON.stringify(spec.semanticId)};`);
  // Pivot/group semantics carry the semantic marker on the group; mesh-root semantics carry
  // it on their meshes (ownership falls through to the root), never both — duplicate
  // semantic attribution is ambiguous at snapshot time.
  if ((spec.kind ?? "mesh-root") === "group") lines.push(`  group.userData.semanticId = ${JSON.stringify(spec.semanticId)};`);
  const origin = spec.origin ?? [0, 0, 0];
  lines.push(`  group.position.set(${origin.map((value) => Number(value.toFixed(6))).join(", ")});`);
  for (const [index, part] of compiled.parts.entries()) {
    const material = part.material;
    const colorArgs = material.colorLinear.map((value) => value.toString()).join(", ");
    lines.push(`  {`);
    lines.push(`    const geometry = new THREE.BufferGeometry();`);
    lines.push(`    geometry.setAttribute("position", new THREE.BufferAttribute(P${index}, 3));`);
    lines.push(`    geometry.setIndex(new THREE.BufferAttribute(I${index}, 1));`);
    lines.push(`    geometry.computeVertexNormals();`);
    lines.push(`    const material = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(${colorArgs}, THREE.LinearSRGBColorSpace), roughness: ${material.roughness}, metalness: ${material.metalness} });`);
    lines.push(`    material.flatShading = ${material.flatShading};`);
    lines.push(`    const mesh = new THREE.Mesh(geometry, material);`);
    lines.push(`    mesh.name = ${JSON.stringify(`${spec.semanticId}/${part.name}`)};`);
    lines.push(`    mesh.userData.semanticId = ${JSON.stringify(spec.semanticId)};`);
    lines.push(`    group.add(mesh);`);
    lines.push(`  }`);
  }
  lines.push(`  return group;`);
  lines.push(`}`);
  lines.push(``);
  return lines.join("\n");
}

/** Canonical authored module path for a semantic (kept OUTSIDE the derived .generated tree). */
export const AUTHORED_GENERATED_DIRECTORY = "model/.generated-authored";
export const AUTHORED_REGISTRY_PATH = `${AUTHORED_GENERATED_DIRECTORY}/registry.mjs`;

export function authoredModulePath(semanticId: string): string {
  return `${AUTHORED_GENERATED_DIRECTORY}/${semanticId}.mjs`;
}

/** Authored entry scaffold: the stable model entry for stylized-authored projects. */
export const MODEL_STYLIZED_SCAFFOLD = `import { createAuthoredCandidate } from "./.generated-authored/registry.mjs";

export function createCandidate() {
  return createAuthoredCandidate();
}
`;

/**
 * Deterministically regenerates the pipeline-owned authored composition layer from the
 * currently bound authored semantics, in the given (stable) order. The authored entry imports
 * this module exactly once; builders never author the registry.
 */
export function generateAuthoredRegistrySource(orderedSemantics: ReadonlyArray<string>, pivotNestings: ReadonlyArray<readonly [string, string]> = []): string {
  const identifier = (semantic: string): string => `createSeed${semantic.replace(/[^a-z0-9]+/giu, "")}`;
  const lines: string[] = [];
  lines.push(`// Generated by mesh2threejs author-compiler ${AUTHORED_COMPILER_VERSION} — trusted authored composition layer (do not edit by hand).`);
  lines.push(`import * as THREE from "three";`);
  for (const semantic of orderedSemantics) lines.push(`import { createSeed as ${identifier(semantic)} } from "./${semantic}.mjs";`);
  lines.push(``);
  lines.push(`export function createAuthoredCandidate() {`);
  lines.push(`  const root = new THREE.Group();`);
  lines.push(`  root.name = "candidate";`);
  for (const semantic of orderedSemantics) {
    const seed = identifier(semantic);
    lines.push(`  root.add(${seed}());`);
  }
  // Pivot nesting: authored pivot semantics (transform-only groups) parented via
  // parentSemanticId are nested under their pivot parent with world-preserving rebake,
  // mirroring the derived registry so articulation controls move descendants.
  lines.push(`  const childWorld = new THREE.Vector3();`);
  lines.push(`  const parentWorld = new THREE.Vector3();`);
  lines.push(`  const nestings = ${JSON.stringify(pivotNestings)};`);
  lines.push(`  for (const [childName, parentName] of nestings) {`);
  lines.push(`    const child = root.getObjectByName(childName);`);
  lines.push(`    const parent = root.getObjectByName(parentName);`);
  lines.push(`    if (!child || !parent || child === parent) continue;`);
  lines.push(`    child.getWorldPosition(childWorld);`);
  lines.push(`    if (child.parent) child.removeFromParent();`);
  lines.push(`    parent.add(child);`);
  lines.push(`    parent.getWorldPosition(parentWorld);`);
  lines.push(`    child.position.set(childWorld.x - parentWorld.x, childWorld.y - parentWorld.y, childWorld.z - parentWorld.z);`);
  lines.push(`  }`);
  lines.push(`  return {`);
  lines.push(`    root,`);
  lines.push(`    setPose(pose) {`);
  lines.push(`      const p = pose ?? {};`);
  lines.push(`      const turretPivot = root.getObjectByName("turret-pivot");`);
  lines.push(`      if (turretPivot) turretPivot.rotation.y = p.turretYaw ?? 0;`);
  lines.push(`      const gunPivot = root.getObjectByName("gun-pivot");`);
  lines.push(`      if (gunPivot) gunPivot.rotation.x = p.gunElevation ?? 0;`);
  lines.push(`    },`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);
  return lines.join("\n");
}

export function emptyAuthoredRegistry(): string {
  return generateAuthoredRegistrySource([]);
}
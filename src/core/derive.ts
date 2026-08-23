import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { join } from "node:path";
import * as THREE from "three";
import { MeshoptSimplifier } from "meshoptimizer";
import type { ResumedWorkspace } from "./workspace.js";
import { MODEL_DERIVED_SCAFFOLD, MODEL_SCAFFOLD, verifyWorkspaceCandidateIdentity, verifyWorkspaceOraclePreparation } from "./workspace.js";
import { loadPreparedOracle } from "./oracle.js";
import { loadTaskState, saveTaskState } from "./state.js";
import { canonicalJson, sha256 } from "./hashing.js";
import { snapshotScene } from "./geometry.js";
import { measureBounds, measureWheelRadialProfile } from "./measurement.js";
import { evaluateCandidateWithPoses } from "./orchestration.js";
import { getProfileContract } from "./contracts.js";
import {
  GENERATED_DIRECTORY,
  GENERATED_REGISTRY_PATH,
  derivedDirectory,
  derivationManifestHash,
  generateRegistrySource,
  loadTrustedGeneratedModules,
  type DerivationManifest,
} from "./derivation.js";
import { composeCandidateForPhase, type ComposedCandidateRuntime } from "./phase-compose.js";
import type { GenericSubjectContract } from "../profiles/generic.js";
import type { Bounds3, CandidateRuntime, Point3, ProfileId, SceneSnapshot, Workorder } from "../types.js";

export type DeriveQuality = "aggressive" | "balanced" | "conservative";

export interface DeriveOptions {
  quality?: DeriveQuality;
}

export interface DeriveTierResult {
  tier: DeriveTierResultTier;
  triangles: number;
  passed: boolean;
  score: number;
  /** Active-phase gates that failed for this tier, with their runtime evidence. */
  failingGates?: Array<{ code: string; score: number; message: string }>;
  /** False when the tier cleared active gates but already violates the style complexity ceiling. */
  withinComplexityBudget?: boolean;
  simplifierError?: number;
}

export type DeriveTierResultTier = "aggressive" | "balanced" | "conservative" | "source-cleaned";

export type DeriveStatus = "seed-passing" | "seed-retained-failing" | "seed-diagnostic-overbudget" | "not-supported";

/** Workflow diagnostics for structured diagnosis; not profile gates. */
export type DeriveReasonCode =
  | "derive.no-passing-tier"
  | "derive.over-budget-fallback"
  | "derive.missing-prerequisite-semantic"
  | "derive.generated-hierarchy-invalid";

export interface DeriveResult {
  status: DeriveStatus;
  reasonCode?: DeriveReasonCode;
  phase: string;
  operator: string;
  generatedModule?: string;
  manifest?: string;
  tiers: DeriveTierResult[];
  selected?: DeriveTierResult;
  workorders?: Workorder[];
  wiring?: "initialized-scaffold" | "updated-registry" | "manual-wiring-required";
  note?: string;
}

/** Deterministic seed route per active builder phase. */
function phaseOperator(phase: string): { operator: DerivationManifest["operator"]; semantics: (id: string) => boolean; label: string } | null {
  if (phase === "hull") return { operator: "mesh-simplify", semantics: (id) => id.startsWith("hull"), label: "hull" };
  if (phase === "turret") return { operator: "mesh-simplify", semantics: (id) => id === "turret" || id === "cupola", label: "turret" };
  if (phase === "gun") return { operator: "axis-fit", semantics: () => false, label: "gun" };
  if (phase === "running-gear") return { operator: "radial-fit", semantics: (id) => /^(road-wheel|sprocket|idler|return-roller)/u.test(id), label: "running gear" };
  if (phase === "tracks") return { operator: "course-regenerate", semantics: (id) => id.startsWith("track"), label: "tracks" };
  return null;
}

const TIERS: ReadonlyArray<{ tier: DeriveTierResultTier; ratio?: number; error?: number }> = [
  { tier: "aggressive", ratio: 0.02, error: 0.05 },
  { tier: "balanced", ratio: 0.05, error: 0.03 },
  { tier: "conservative", ratio: 0.12, error: 0.01 },
  { tier: "source-cleaned" },
];

function tiersForQuality(quality: DeriveQuality | undefined, analytic: boolean): ReadonlyArray<{ tier: DeriveTierResultTier; ratio?: number; error?: number }> {
  // Analytic routes regenerate primitives deterministically; there is exactly one recipe.
  if (analytic) return TIERS.slice(-1);
  const index = TIERS.findIndex((tier) => tier.tier === quality);
  return index >= 0 ? TIERS.slice(0, index + 1) : TIERS;
}

interface TriangleSoup {
  positions: number[];
  indices: number[];
  triangleCount: number;
}

/**
 * Collects world-space triangle soup for the selected oracle semantics. Positions come from
 * the evaluator's own snapshot pipeline, so transforms are baked identically and the seed
 * measures exactly like the oracle surfaces it came from.
 */
function collectSemantics(snapshot: SceneSnapshot, predicate: (id: string) => boolean): Map<string, TriangleSoup> {
  const soups = new Map<string, TriangleSoup>();
  for (const component of Object.values(snapshot.components)) {
    if (!predicate(component.id) || !component.triangleIndices.length) continue;
    const soup: TriangleSoup = { positions: [], indices: [], triangleCount: component.triangleIndices.length };
    const baseByPosition = new Map<string, number>();
    for (const localIndex of component.triangleIndices) {
      const offset = localIndex * 9;
      for (let vertex = 0; vertex < 3; vertex += 1) {
        const x = Number(snapshot.triangleData.positions[offset + vertex * 3]!.toFixed(6));
        const y = Number(snapshot.triangleData.positions[offset + vertex * 3 + 1]!.toFixed(6));
        const z = Number(snapshot.triangleData.positions[offset + vertex * 3 + 2]!.toFixed(6));
        const key = `${x},${y},${z}`;
        let base = baseByPosition.get(key);
        if (base === undefined) {
          base = soup.positions.length / 3;
          baseByPosition.set(key, base);
          soup.positions.push(x, y, z);
        }
        soup.indices.push(base);
      }
    }
    soups.set(component.id, soup);
  }
  return soups;
}

interface CleanedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  components: Array<{ indices: Uint32Array; area: number; bounds: Bounds3 }>;
}

/**
 * Welds duplicated vertices (within a small tolerance), drops degenerate triangles, and
 * splits connected components, characterizing each by surface area and bounds so clearly
 * insignificant pieces can be pruned conservatively during seeding.
 */
function cleanAndSplit(soup: TriangleSoup, epsilon: number): CleanedMesh {
  const weld = new Map<string, number>();
  const keptPositions: number[] = [];
  const keptTriangles: number[][] = [];
  for (let slot = 0; slot < soup.indices.length; slot += 3) {
    const triangleSlots: number[] = [];
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const source = soup.indices[slot + vertex]!;
      const x = soup.positions[source * 3]!;
      const y = soup.positions[source * 3 + 1]!;
      const z = soup.positions[source * 3 + 2]!;
      const key = `${Math.round(x / epsilon)},${Math.round(y / epsilon)},${Math.round(z / epsilon)}`;
      let target = weld.get(key);
      if (target === undefined) {
        target = keptPositions.length / 3;
        weld.set(key, target);
        keptPositions.push(x, y, z);
      }
      triangleSlots.push(target);
    }
    const a = triangleSlots[0]!;
    const b = triangleSlots[1]!;
    const c = triangleSlots[2]!;
    if (a === b || b === c || a === c) continue;
    const ax = keptPositions[a * 3]!; const ay = keptPositions[a * 3 + 1]!; const az = keptPositions[a * 3 + 2]!;
    const bx = keptPositions[b * 3]!; const by = keptPositions[b * 3 + 1]!; const bz = keptPositions[b * 3 + 2]!;
    const cx = keptPositions[c * 3]!; const cy = keptPositions[c * 3 + 1]!; const cz = keptPositions[c * 3 + 2]!;
    const cross = Math.hypot(
      (by - ay) * (cz - az) - (bz - az) * (cy - ay),
      (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
      (bx - ax) * (cy - ay) - (by - ay) * (cx - ax),
    );
    if (!(cross > 1e-12)) continue;
    keptTriangles.push(triangleSlots);
  }
  const roots = new Int32Array(keptTriangles.length);
  for (let index = 0; index < roots.length; index += 1) roots[index] = index;
  const findRoot = (value: number): number => {
    let root = value;
    while (roots[root] !== root) root = roots[root]!;
    while (roots[value] !== value) { const next = roots[value]!; roots[value] = root; value = next; }
    return root;
  };
  const unionRoot = (a: number, b: number): void => { const ra = findRoot(a); const rb = findRoot(b); if (ra !== rb) roots[rb] = ra; };
  const owner = new Map<number, number>();
  keptTriangles.forEach((triangle, index) => {
    for (const vertex of triangle) {
      const previous = owner.get(vertex);
      if (previous === undefined) owner.set(vertex, index);
      else unionRoot(previous, index);
    }
  });
  const groups = new Map<number, number[][]>();
  keptTriangles.forEach((triangle, index) => {
    const root = findRoot(index);
    const list = groups.get(root);
    if (list) list.push(triangle);
    else groups.set(root, [triangle]);
  });
  const positions = Float32Array.from(keptPositions);
  const components: CleanedMesh["components"] = [];
  for (const triangles of groups.values()) {
    const indices = new Uint32Array(triangles.length * 3);
    let area = 0;
    const min: Point3 = [Infinity, Infinity, Infinity];
    const max: Point3 = [-Infinity, -Infinity, -Infinity];
    triangles.forEach((triangle, slot) => {
      for (let vertex = 0; vertex < 3; vertex += 1) {
        const base = triangle[vertex]!;
        indices[slot * 3 + vertex] = base;
        const x = positions[base * 3]!; const y = positions[base * 3 + 1]!; const z = positions[base * 3 + 2]!;
        min[0] = Math.min(min[0]!, x); min[1] = Math.min(min[1]!, y); min[2] = Math.min(min[2]!, z);
        max[0] = Math.max(max[0]!, x); max[1] = Math.max(max[1]!, y); max[2] = Math.max(max[2]!, z);
      }
      const p0: Point3 = [positions[triangle[0]! * 3]!, positions[triangle[0]! * 3 + 1]!, positions[triangle[0]! * 3 + 2]!];
      const p1: Point3 = [positions[triangle[1]! * 3]!, positions[triangle[1]! * 3 + 1]!, positions[triangle[1]! * 3 + 2]!];
      const p2: Point3 = [positions[triangle[2]! * 3]!, positions[triangle[2]! * 3 + 1]!, positions[triangle[2]! * 3 + 2]!];
      area += triangleArea(p0, p1, p2);
    });
    const size: Point3 = [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!];
    components.push({ indices, area, bounds: { min: [...min] as Point3, max: [...max] as Point3, size, center: [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2] } });
  }
  const indices = new Uint32Array(components.reduce((sum, component) => sum + component.indices.length, 0));
  let cursor = 0;
  for (const component of components) { indices.set(component.indices, cursor); cursor += component.indices.length; }
  return { positions, indices, components };
}

function triangleArea(a: Point3, b: Point3, c: Point3): number {
  return Math.hypot(
    (b[1]! - a[1]!) * (c[2]! - a[2]!) - (b[2]! - a[2]!) * (c[1]! - a[1]!),
    (b[2]! - a[2]!) * (c[0]! - a[0]!) - (b[0]! - a[0]!) * (c[2]! - a[2]!),
    (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!),
  ) / 2;
}

/**
 * Conservative insignificant-component pruning for SEED GENERATION ONLY: a component is
 * removed when it is clearly negligible in BOTH relative surface area AND relative bounds.
 * When uncertain, the component is kept — the simplifier can shed complexity later.
 */
function pruneInsignificant(mesh: CleanedMesh): CleanedMesh {
  if (mesh.components.length <= 1) return mesh;
  const totalArea = mesh.components.reduce((sum, component) => sum + component.area, 0);
  const maxDiagonal = Math.max(...mesh.components.map((component) => Math.hypot(component.bounds.size[0], component.bounds.size[1], component.bounds.size[2])));
  const kept = mesh.components.filter((component) => {
    const diagonal = Math.hypot(component.bounds.size[0], component.bounds.size[1], component.bounds.size[2]);
    return component.area >= totalArea * 0.005 || diagonal >= maxDiagonal * 0.05;
  });
  if (kept.length === mesh.components.length) return mesh;
  const indices = new Uint32Array(kept.reduce((sum, component) => sum + component.indices.length, 0));
  let cursor = 0;
  for (const component of kept) { indices.set(component.indices, cursor); cursor += component.indices.length; }
  return { ...mesh, indices, components: kept };
}

async function simplifyMesh(positions: Float32Array, indices: Uint32Array, ratio: number | undefined, targetError: number | undefined): Promise<{ positions: Float32Array; indices: Uint32Array; error?: number }> {
  await MeshoptSimplifier.ready;
  if (ratio === undefined || indices.length / 3 <= 24) return compactGeometry(positions, indices);
  const targetIndexCount = Math.max(3, Math.floor((indices.length * ratio) / 3) * 3);
  const [simplified, error] = MeshoptSimplifier.simplify(indices, positions, 3, targetIndexCount, targetError ?? 0.01, ["LockBorder"]);
  const compacted = await compactGeometry(positions, simplified);
  return { ...compacted, error };
}

async function compactGeometry(positions: Float32Array, indices: Uint32Array): Promise<{ positions: Float32Array; indices: Uint32Array }> {
  await Promise.resolve();
  const remap = new Map<number, number>();
  const outPositions: number[] = [];
  const outIndices = new Uint32Array(indices.length);
  for (let slot = 0; slot < indices.length; slot += 1) {
    const original = indices[slot]!;
    let mapped = remap.get(original);
    if (mapped === undefined) {
      mapped = outPositions.length / 3;
      remap.set(original, mapped);
      outPositions.push(positions[original * 3]!, positions[original * 3 + 1]!, positions[original * 3 + 2]!);
    }
    outIndices[slot] = mapped;
  }
  return { positions: Float32Array.from(outPositions), indices: outIndices };
}

function geometryBytesHash(positions: Float32Array, indices: Uint32Array): string {
  return sha256(Buffer.concat([
    Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength),
    Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength),
  ]));
}

function roundList(values: ArrayLike<number>, decimals = 5): number[] {
  return Array.from(values, (value) => Number(value.toFixed(decimals)));
}

/**
 * Hierarchy-aware generated seed representation. Groups carry semantic pivots at their world
 * origins; meshes attach to their declared semantic owner with OWNER-LOCAL geometry, so the
 * emitted module reproduces physically correct articulation ownership (gun under gun-pivot,
 * turret assembly under turret-pivot) instead of flat siblings that can never clear gates
 * like gun.pose or turretYaw articulation.
 */
export interface SeedNode {
  semanticId: string;
  kind: "group" | "mesh";
  parentSemanticId?: string;
  /** Local position for group nodes. */
  position?: Point3;
  /** Owner-local coordinates for mesh nodes. */
  positions?: Float32Array;
  indices?: Uint32Array;
  role?: string;
}

/** Builds the in-memory evaluation graph for one seed tier. */
export function buildSeedGroup(name: string, nodes: SeedNode[]): THREE.Group {
  const group = new THREE.Group();
  group.name = `derived-${name}`;
  const bySemantic = new Map<string, THREE.Object3D>();
  // Groups first so parents exist before children attach.
  for (const node of nodes.filter((entry) => entry.kind === "group")) {
    const object = new THREE.Group();
    object.name = node.semanticId;
    object.userData.semanticId = node.semanticId;
    object.position.set(...(node.position ?? [0, 0, 0]));
    bySemantic.set(node.semanticId, object);
  }
  const attach = (object: THREE.Object3D, parentSemanticId: string | undefined): void => {
    const parent = parentSemanticId ? bySemantic.get(parentSemanticId) : undefined;
    (parent ?? group).add(object);
  };
  for (const node of bySemantic.values() as IterableIterator<THREE.Object3D>) attach(node, nodes.find((entry) => entry.kind === "group" && entry.semanticId === node.name)?.parentSemanticId);
  for (const node of nodes.filter((entry) => entry.kind === "mesh")) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(node.positions!, 3));
    geometry.setIndex(new THREE.BufferAttribute(node.indices!, 1));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0x6b7358, roughness: 0.7 });
    material.flatShading = true;
    const object = new THREE.Mesh(geometry, material);
    object.name = node.semanticId;
    object.userData.semanticId = node.semanticId;
    if (node.role) object.userData.semanticRole = node.role;
    attach(object, node.parentSemanticId);
  }
  return group;
}

/** Emits the pipeline-owned generated module bytes for one derived phase seed. */
function emitGeneratedModule(name: string, nodes: SeedNode[]): string {
  const lines: string[] = [];
  lines.push(`import * as THREE from "three";`);
  lines.push(``);
  lines.push(`// Generated by mesh2threejs derive — trusted pipeline tool output.`);
  lines.push(`// Provenance: .mesh2threejs/derived/${name}.json (do not edit by hand).`);
  const meshes = nodes.filter((node): node is SeedNode & { kind: "mesh"; positions: Float32Array; indices: Uint32Array } => node.kind === "mesh");
  for (const mesh of meshes) {
    // Fail fast: an out-of-range index silently becomes a NaN triangle downstream, which
    // finishBounds() masks as an all-zero component bounds box and produces misleading
    // detached-geometry gate failures far from the actual defect.
    const vertexCount = mesh.positions.length / 3;
    if (Array.from(mesh.indices).some((index) => index >= vertexCount)) {
      throw new Error(`derived ${mesh.semanticId} contains index outside vertex range`);
    }
  }
  meshes.forEach((mesh, index) => {
    lines.push(`const P${index} = new Float32Array([${roundList(mesh.positions).join(",")}]);`);
    lines.push(`const I${index} = new Uint32Array([${Array.from(mesh.indices).join(",")}]);`);
  });
  lines.push(``);
  lines.push(`export function createSeed() {`);
  lines.push(`  const group = new THREE.Group();`);
  lines.push(`  group.name = ${JSON.stringify(`derived-${name}`)};`);
  // Groups first (fully constructed and ATTACHED), then meshes reference their owner.
  for (const node of nodes.filter((entry) => entry.kind === "group")) {
    lines.push(`  {`);
    lines.push(`    const pivotGroup = new THREE.Group();`);
    lines.push(`    pivotGroup.name = ${JSON.stringify(node.semanticId)};`);
    lines.push(`    pivotGroup.userData.semanticId = ${JSON.stringify(node.semanticId)};`);
    lines.push(`    pivotGroup.position.set(${(node.position ?? [0, 0, 0]).map((value) => Number(value.toFixed(6))).join(", ")});`);
    lines.push(`    group.add(pivotGroup);`);
    lines.push(`  }`);
  }
  const meshIndexByNode = new Map<SeedNode, number>();
  meshes.forEach((mesh, index) => meshIndexByNode.set(mesh, index));
  for (const node of meshes) {
    const index = meshIndexByNode.get(node)!;
    lines.push(`  {`);
    lines.push(`    const geometry = new THREE.BufferGeometry();`);
    lines.push(`    geometry.setAttribute("position", new THREE.BufferAttribute(P${index}, 3));`);
    lines.push(`    geometry.setIndex(new THREE.BufferAttribute(I${index}, 1));`);
    lines.push(`    geometry.computeVertexNormals();`);
    lines.push(`    const material = new THREE.MeshStandardMaterial({ color: 0x6b7358, roughness: 0.7 });`);
    lines.push(`    material.flatShading = true;`);
    lines.push(`    const mesh = new THREE.Mesh(geometry, material);`);
    lines.push(`    mesh.name = ${JSON.stringify(node.semanticId)};`);
    lines.push(`    mesh.userData.semanticId = ${JSON.stringify(node.semanticId)};`);
    if (node.role) lines.push(`    mesh.userData.semanticRole = ${JSON.stringify(node.role)};`);
    if (node.parentSemanticId) {
      lines.push(`    (group.getObjectByName(${JSON.stringify(node.parentSemanticId)}) ?? group).add(mesh);`);
    } else {
      lines.push(`    group.add(mesh);`);
    }
    lines.push(`  }`);
  }
  lines.push(`  return group;`);
  lines.push(`}`);
  lines.push(``);
  return lines.join("\n");
}

function wheelRole(id: string, declared?: unknown): string | undefined {
  if (typeof declared === "string" && declared.trim()) return declared;
  return ["road-wheel", "sprocket", "idler", "return-roller"].find((role) => id === role || id.startsWith(`${role}-`));
}

function localPositions(worldPositions: ArrayLike<number>, origin: Point3): Float32Array {
  const local = Float32Array.from(worldPositions);
  for (let index = 0; index < local.length; index += 3) {
    local[index] = Number((local[index]! - origin[0]).toFixed(5));
    local[index + 1] = Number((local[index + 1]! - origin[1]).toFixed(5));
    local[index + 2] = Number((local[index + 2]! - origin[2]).toFixed(5));
  }
  return local;
}

/** Builds the analytic radial-fit seed: one low-segment closed radial wheel per measured instance. */
function buildRadialSeed(snapshot: SceneSnapshot): { nodes: SeedNode[]; inputTriangles: number } {
  const nodes: SeedNode[] = [];
  let inputTriangles = 0;
  for (const component of Object.values(snapshot.components)) {
    const role = wheelRole(component.id, component.role);
    if (!role || !component.triangleIndices.length) continue;
    inputTriangles += component.triangleIndices.length;
    // Size the seed from the same bounds-envelope measurements the evaluator uses
    // (radius = max Y/Z extent half, width = X extent): profile.meanRadius averages every
    // projected edge sample including end-cap fans, underestimating the outer radius.
    const radius = Math.max(Math.max(component.bounds.size[1], component.bounds.size[2]) / 2, 1e-3);
    const width = Math.max(component.bounds.size[0], 1e-3);
    const segments = 12;
    const centerX = component.bounds.center[0];
    const centerY = component.bounds.center[1];
    const centerZ = component.bounds.center[2];
    const positions: number[] = [];
    const indices: number[] = [];
    for (let ring = 0; ring < 2; ring += 1) {
      const x = centerX + (ring - 0.5) * width;
      for (let segment = 0; segment < segments; segment += 1) {
        const angle = (segment / segments) * Math.PI * 2;
        positions.push(x, centerY + radius * Math.cos(angle), centerZ + radius * Math.sin(angle));
      }
    }
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      indices.push(segment, segments + next, segments + segment);
      indices.push(segment, next, segments + next);
    }
    // Closed end caps keep the seed watertight for later style gates.
    for (const [centerIndex, ringIndex] of [[0, 0], [segments, 1]] as Array<[number, number]>) {
      for (let segment = 1; segment < segments - 1; segment += 1) {
        indices.push(centerIndex, ringIndex * segments + segment + (ringIndex ? 1 : 0), ringIndex * segments + segment + (ringIndex ? 0 : 1));
      }
    }
    nodes.push({ semanticId: component.id, kind: "mesh", role, positions: Float32Array.from(positions), indices: Uint32Array.from(indices) });
  }
  return { nodes, inputTriangles };
}

/**
 * Builds the course-regenerate seed: one continuous low-poly course per measured track,
 * matching the measured envelope (length along Z, height along Y, width along X).
 */
function buildTrackSeed(snapshot: SceneSnapshot): { nodes: SeedNode[]; inputTriangles: number } {
  const nodes: SeedNode[] = [];
  let inputTriangles = 0;
  for (const component of Object.values(snapshot.components)) {
    if (!component.id.startsWith("track") && component.role !== "track-course") continue;
    if (!component.triangleIndices.length) continue;
    inputTriangles += component.triangleIndices.length;
    const size = component.bounds.size;
    const length = size[2];
    const height = size[1];
    const width = size[0];
    const wrapRadius = Math.max(Math.min(height * 0.42, length * 0.15), 0.03);
    const center = component.bounds.center;
    const inset = Math.min(width * 0.45, wrapRadius * 0.6);
    const roundedProfile = (radius: number, insetAmount: number): Array<[number, number]> => {
      const left = -length / 2 + insetAmount;
      const right = length / 2 - insetAmount;
      const bottom = -height / 2 + insetAmount;
      const top = height / 2 - insetAmount;
      const arc = (cx: number, cy: number, from: number, steps: number): void => {
        for (let step = 1; step <= steps; step += 1) {
          const angle = from + (step / steps) * (Math.PI / 2);
          points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
        }
      };
      const points: Array<[number, number]> = [];
      // Twelve steps per quarter-arc: the wrap-normal diagnostic bins face normals at
      // 7.5° granularity and demands near-source diversity, so the arc must place at
      // least one facet in every angular bin the source's curved wrap covers.
      const arcSteps = 12;
      points.push([left + radius, bottom]);
      points.push([right - radius, bottom]);
      arc(right - radius, bottom + radius, -Math.PI / 2, arcSteps);
      points.push([right, top - radius]);
      arc(right - radius, top - radius, 0, arcSteps);
      points.push([left + radius, top]);
      arc(left + radius, top - radius, Math.PI / 2, arcSteps);
      points.push([left, bottom + radius]);
      arc(left + radius, bottom + radius, Math.PI, arcSteps);
      return points;
    };
    const outerPoints = roundedProfile(wrapRadius, 0);
    const innerPoints = roundedProfile(Math.max(wrapRadius - inset, 0.02), inset);
    const positions: number[] = [];
    const indices: number[] = [];
    const ringCount = 2;
    for (let ring = 0; ring < ringCount; ring += 1) {
      const x = center[0] + (ring - 0.5) * width;
      for (const point of outerPoints) positions.push(x, center[1] + point[1], center[2] + point[0]);
    }
    const frontBase = ringCount * outerPoints.length;
    for (const point of innerPoints) positions.push(center[0], center[1] + point[1], center[2] + point[0]);
    const backBase = frontBase + innerPoints.length;
    for (const point of innerPoints) positions.push(center[0], center[1] + point[1], center[2] + point[0]);
    const outerSlot = (ring: number, index: number): number => ring * outerPoints.length + (((index % outerPoints.length) + outerPoints.length) % outerPoints.length);
    for (let ring = 0; ring < ringCount; ring += 1) {
      for (let index = 0; index < outerPoints.length; index += 1) {
        const a = outerSlot(ring, index);
        const b = outerSlot(ring, index + 1);
        const c = outerSlot(1 - ring, index + 1);
        const d = outerSlot(1 - ring, index);
        indices.push(a, b, c, a, c, d);
      }
    }
    for (let index = 0; index < outerPoints.length; index += 1) {
      const o0 = outerSlot(0, index);
      const o1 = outerSlot(0, index + 1);
      const i0 = frontBase + (index % innerPoints.length);
      const i1 = frontBase + ((index + 1) % innerPoints.length);
      indices.push(o0, i1, i0);
      indices.push(o0, o1, i1);
      const b0 = outerSlot(1, index);
      const b1 = outerSlot(1, index + 1);
      const j0 = backBase + (index % innerPoints.length);
      const j1 = backBase + ((index + 1) % innerPoints.length);
      indices.push(b0, j0, j1);
      indices.push(b0, j1, b1);
    }
    nodes.push({ semanticId: component.id, kind: "mesh", role: component.role ?? "track-course", positions: Float32Array.from(positions), indices: Uint32Array.from(indices) });
  }
  return { nodes, inputTriangles };
}

/**
 * Builds the axis-fit gun seed with CORRECT semantic hierarchy: gun-pivot group at the
 * measured pivot anchor, gun mesh child in PIVOT-LOCAL coordinates, so gun.parent resolves
 * to gun-pivot and pose/articulation gates are structurally satisfiable.
 */
function buildGunSeed(snapshot: SceneSnapshot): { nodes: SeedNode[]; inputTriangles: number } {
  const pivotComponent = snapshot.components["gun-pivot"];
  const gun = snapshot.components.gun;
  if (!gun || !gun.triangleIndices.length) throw new Error("prepared oracle carries no gun geometry to fit");
  const pivotOrigin: Point3 = pivotComponent?.origin ?? gun.bounds.center;
  const points: Point3[] = [];
  for (const localIndex of gun.triangleIndices) {
    const offset = localIndex * 9;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      points.push([
        snapshot.triangleData.positions[offset + vertex * 3]!,
        snapshot.triangleData.positions[offset + vertex * 3 + 1]!,
        snapshot.triangleData.positions[offset + vertex * 3 + 2]!,
      ]);
    }
  }
  const distanceFromPivot = (point: Point3): number => Math.hypot(point[0] - pivotOrigin[0], point[1] - pivotOrigin[1], point[2] - pivotOrigin[2]);
  const muzzle = points.reduce((best, point) => distanceFromPivot(point) > distanceFromPivot(best) ? point : best, points[0]!);
  const vector = muzzle.map((value, axis) => value - pivotOrigin[axis]!) as Point3;
  // Length/axis via center projection: avoids rim-corner bias (farthest rim point is sqrt(L^2+r^2) off).
  const centerVector = gun.bounds.center.map((value, axis) => value - pivotOrigin[axis]!) as Point3;
  const centerDistance = Math.hypot(...centerVector);
  const direction = centerDistance > 1e-9 ? centerVector.map((value) => value / centerDistance) as Point3 : vector.map((value) => value / Math.max(Math.hypot(...vector), 1e-9)) as Point3;
  const length = centerDistance > 1e-9 ? centerDistance * 2 : Math.hypot(...vector);
  const radii = points.filter((_, index) => index % 16 === 0).map((point) => {
    const dx = point[0] - pivotOrigin[0]; const dy = point[1] - pivotOrigin[1]; const dz = point[2] - pivotOrigin[2];
    const along = dx * direction[0]! + dy * direction[1]! + dz * direction[2]!;
    return Math.sqrt(Math.max(dx * dx + dy * dy + dz * dz - along * along, 0));
  }).sort((a, b) => a - b);
  const radius = Math.max(radii[Math.floor(radii.length * 0.8)] ?? 0.1, 1e-3);
  const segments = 10;
  const helper: Point3 = Math.abs(direction[1]!) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const sideRaw: Point3 = [
    direction[1]! * helper[2]! - direction[2]! * helper[1]!,
    direction[2]! * helper[0]! - direction[0]! * helper[2]!,
    direction[0]! * helper[1]! - direction[1]! * helper[0]!,
  ];
  const sideLength = Math.hypot(...sideRaw) || 1;
  const side = sideRaw.map((value) => value / sideLength) as Point3;
  const secondRaw: Point3 = [
    direction[1]! * side[2]! - direction[2]! * side[1]!,
    direction[2]! * side[0]! - direction[0]! * side[2]!,
    direction[0]! * side[1]! - direction[1]! * side[0]!,
  ];
  const secondLength = Math.hypot(...secondRaw) || 1;
  const second = secondRaw.map((value) => value / secondLength) as Point3;
  const world: number[] = [];
  const indices: number[] = [];
  // Tube spans exactly [0, L] from the pivot: the measured muzzle length must survive.
  for (let ring = 0; ring < 2; ring += 1) {
    const along = ring * length;
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const cos = Math.cos(angle) * radius;
      const sin = Math.sin(angle) * radius;
      world.push(
        pivotOrigin[0]! + direction[0]! * along + side[0]! * cos + second[0]! * sin,
        pivotOrigin[1]! + direction[1]! * along + side[1]! * cos + second[1]! * sin,
        pivotOrigin[2]! + direction[2]! * along + side[2]! * cos + second[2]! * sin,
      );
    }
  }
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    indices.push(segment, segments + next, segments + segment);
    indices.push(segment, next, segments + next);
  }
  for (let segment = 1; segment < segments - 1; segment += 1) indices.push(0, segment, segment + 1);
  const capBase = segments;
  for (let segment = 1; segment < segments - 1; segment += 1) indices.push(capBase, capBase + segment + 1, capBase + segment);
  return {
    nodes: [
      { semanticId: "gun-pivot", kind: "group", position: pivotOrigin },
      { semanticId: "gun", kind: "mesh", parentSemanticId: "gun-pivot", positions: localPositions(Float32Array.from(world), pivotOrigin), indices: Uint32Array.from(indices) },
    ],
    inputTriangles: gun.triangleIndices.length,
  };
}

interface PhaseSeed {
  name: string;
  inputGeometryHash: string;
  inputTriangles: number;
  simplify: (ratio: number | undefined, error: number | undefined) => Promise<{ nodes: SeedNode[]; error?: number }>;
}

async function buildMeshSimplifySeed(snapshot: SceneSnapshot, phase: string): Promise<PhaseSeed> {
  const route = phaseOperator(phase)!;
  const soups = collectSemantics(snapshot, route.semantics);
  if (!soups.size) throw new Error(`prepared oracle carries no ${route.label} geometry to derive from`);
  const inputTriangles = [...soups.values()].reduce((sum, soup) => sum + soup.triangleCount, 0);
  const overallSize = measureBounds(snapshot).size.filter((value) => value > 0);
  const epsilon = Math.max(Math.max(...overallSize, 1e-9) * 2e-5, 1e-6);
  const cleanedPerSemantic = new Map<string, CleanedMesh>();
  for (const [id, soup] of soups) cleanedPerSemantic.set(id, pruneInsignificant(cleanAndSplit(soup, epsilon)));
  const inputGeometryHash = sha256(canonicalJson([...soups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, soup]) => ({
    id,
    triangles: soup.triangleCount,
    geometryHash: geometryBytesHash(Float32Array.from(soup.positions), Uint32Array.from(soup.indices)),
  }))));

  // Turret assembly nests under its admitted pivot when the oracle declares one.
  let pivotOrigin: Point3 | undefined;
  if (phase === "turret") {
    const marker = snapshot.components["turret-pivot"];
    if (marker?.origin) pivotOrigin = [...marker.origin] as Point3;
  }

  return {
    name: phase.replace(/[^a-z0-9]+/giu, "-").toLowerCase(),
    inputGeometryHash,
    inputTriangles,
    simplify: async (ratio, error) => {
      const nodes: SeedNode[] = [];
      let simplifierError: number | undefined;
      const orderedIds = [...cleanedPerSemantic.keys()].sort((a, b) => a.localeCompare(b));
      if (pivotOrigin) nodes.push({ semanticId: "turret-pivot", kind: "group", position: pivotOrigin });
      for (const id of orderedIds) {
        const cleaned = cleanedPerSemantic.get(id)!;
        const result = await simplifyMesh(cleaned.positions, cleaned.indices, ratio, error);
        if (result.error !== undefined) simplifierError = Math.max(simplifierError ?? 0, result.error);
        const parentSemanticId = pivotOrigin && id !== "turret-pivot" ? "turret-pivot" : undefined;
        const positions = parentSemanticId ? localPositions(result.positions, pivotOrigin!) : result.positions;
        nodes.push({ semanticId: id, kind: "mesh", ...(parentSemanticId ? { parentSemanticId } : {}), positions, indices: result.indices });
      }
      return { nodes, ...(simplifierError !== undefined ? { error: simplifierError } : {}) };
    },
  };
}

/** Evaluates one composed candidate through the real active-phase deterministic gate path. */
async function evaluateComposedCandidate(
  workspace: ResumedWorkspace,
  phase: string,
  oracle: THREE.Object3D,
  authoritativeDimensions: Record<string, number> | undefined,
  composed: CandidateRuntime,
): Promise<{
  passed: boolean;
  score: number;
  triangles: number;
  meshes: number;
  failingGates: Array<{ code: string; score: number; message: string }>;
}> {
  const subjectContract = workspace.resolved.subjectContract
    ? JSON.parse(await readFile(workspace.resolved.subjectContract, "utf8")) as GenericSubjectContract
    : undefined;
  const evaluation = await evaluateCandidateWithPoses({
    oracle,
    candidate: composed,
    profile: workspace.project.profile,
    style: workspace.styleContract,
    certification: workspace.state.certification,
    ...(authoritativeDimensions ? { authoritativeDimensions: authoritativeDimensions as { hullLength: number; overallLength: number; width: number; height: number } } : {}),
    ...(subjectContract ? { subjectContract } : {}),
    phase,
  });
  const phaseReport = evaluation.phaseGates[phase];
  // Early complexity admissibility over the COMPOSED totals: geometrically acceptable is not
  // yet lockable when the workspace hard style ceiling is already exceeded.
  const composedSnapshot = snapshotScene(composed.root);
  return {
    passed: evaluation.passed && Boolean(phaseReport?.passed),
    score: phaseReport?.score ?? evaluation.contractGates.score,
    triangles: composedSnapshot.triangleCount,
    meshes: composedSnapshot.meshCount,
    failingGates: [
      ...evaluation.deterministic.rows.filter((row) => !row.passed).map((row) => ({ code: row.code, score: row.score, message: row.message })),
      ...Object.values(evaluation.phaseGates).flatMap((report) => report.rows.filter((row) => !row.passed).map((row) => ({ code: row.code, score: row.score, message: row.message }))),
    ],
  };
}

async function writeDerivedArtifacts(workspace: ResumedWorkspace, manifest: DerivationManifest, moduleSource: string): Promise<{ modulePath: string; manifestPath: string }> {
  const modulePath = resolve(workspace.root, manifest.generatedModulePath);
  await mkdir(resolve(workspace.root, GENERATED_DIRECTORY), { recursive: true });
  await writeFile(modulePath, moduleSource);
  const manifestDirectory = derivedDirectory(workspace.layout.internal.root);
  await mkdir(manifestDirectory, { recursive: true });
  const manifestPath = join(manifestDirectory, `${manifest.phase}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { modulePath, manifestPath };
}

const REGISTRY_IMPORT_PATTERN = /\.generated\/registry\.mjs/u;

/**
 * Regenerates the pipeline-owned composition layer from current manifests. The authored
 * entry stays stable: pristine scaffolds (legacy plain or registry-aware) are migrated to
 * the registry scaffold once, after which only registry.mjs changes per derivation.
 */
async function wireGeneratedComposition(workspace: ResumedWorkspace, orderedPhases: ReadonlyArray<string>): Promise<DeriveResult["wiring"]> {
  const modelEntryPath = resolve(workspace.root, workspace.project.model);
  let current: string;
  try {
    current = await readFile(modelEntryPath, "utf8");
  } catch {
    return "manual-wiring-required";
  }
  const trimmed = current.trim();
  const pristine = trimmed === MODEL_SCAFFOLD.trim() || trimmed === MODEL_DERIVED_SCAFFOLD.trim() || REGISTRY_IMPORT_PATTERN.test(current);
  await mkdir(resolve(workspace.root, GENERATED_DIRECTORY), { recursive: true });
  await writeFile(resolve(workspace.root, GENERATED_REGISTRY_PATH), generateRegistrySource(workspace.project.profile, orderedPhases));
  if (!pristine) return "manual-wiring-required";
  const scaffold = MODEL_DERIVED_SCAFFOLD;
  if (trimmed !== scaffold.trim()) {
    await writeFile(modelEntryPath, scaffold);
    return "initialized-scaffold";
  }
  return "updated-registry";
}

async function readAllManifests(workspace: ResumedWorkspace): Promise<DerivationManifest[]> {
  let names: string[];
  try {
    names = await readdir(derivedDirectory(workspace.layout.internal.root));
  } catch {
    return [];
  }
  const manifests: DerivationManifest[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      manifests.push(JSON.parse(await readFile(join(derivedDirectory(workspace.layout.internal.root), name), "utf8")) as DerivationManifest);
    } catch { /* ignore unreadable sidecars */ }
  }
  return manifests;
}

/** Trusted-audit options bound to preparation + state bindings + canonical paths. */
export async function trustedGeneratedAuditOptions(workspace: ResumedWorkspace, identity?: string): Promise<{ trustedGeneratedModules: Map<string, unknown> }> {
  const preparationIdentity = identity ?? (await verifyWorkspaceOraclePreparation(workspace)).binding.identity;
  const state = await loadTaskState(workspace.layout.internal.state);
  const contract = getProfileContract(workspace.project.profile);
  const allowedPhases = new Set(contract.phases.filter((phase) => phase.owner === "builder").map((phase) => phase.id));
  const trusted = await loadTrustedGeneratedModules({
    directory: derivedDirectory(workspace.layout.internal.root),
    workspaceRoot: workspace.root,
    preparationIdentity,
    bindings: state.derivedBindings ?? {},
    allowedPhases,
  });
  return { trustedGeneratedModules: trusted };
}

/** Ordered derived phases known to the workspace, in profile contract dependency order. */
function orderedDerivedPhases(profile: ProfileId, manifests: DerivationManifest[]): string[] {
  const present = new Set(manifests.map((manifest) => manifest.phase));
  const contractOrder = getProfileContract(profile).phases.map((phase) => phase.id).filter((id) => present.has(id));
  for (const phase of [...present].sort()) if (!contractOrder.includes(phase)) contractOrder.push(phase);
  return contractOrder;
}

/**
 * Pure tier-selection policy: geometrically acceptable is distinct from LOCKABLE. A tier that
 * cleared active gates but violates the hard style ceiling is diagnostic repair input only.
 */
export function resolveSeedOutcome(tierResults: ReadonlyArray<DeriveTierResult>): { status: DeriveStatus; reasonCode?: DeriveReasonCode; chosen?: DeriveTierResult } {
  const eligiblePassing = tierResults.find((tier) => tier.passed && tier.withinComplexityBudget !== false);
  const overBudgetPassing = tierResults.filter((tier) => tier.passed && tier.withinComplexityBudget === false);
  if (eligiblePassing) return { status: "seed-passing", chosen: eligiblePassing };
  if (overBudgetPassing.length) {
    return { status: "seed-diagnostic-overbudget", reasonCode: "derive.over-budget-fallback", chosen: overBudgetPassing.reduce((best, tier) => (tier.score > best.score ? tier : best)) };
  }
  const best = tierResults.reduce<DeriveTierResult | undefined>((acc, tier) => (!acc || tier.score > acc.score ? tier : acc), undefined);
  return { status: "seed-retained-failing", reasonCode: "derive.no-passing-tier", ...(best ? { chosen: best } : {}) };
}

/**
 * Creates the best cheap source-derived seed for the active builder phase and evaluates it
 * IN CONTEXT: locked prerequisite geometry stays in place, previous active-phase geometry is
 * temporarily replaced, future-phase geometry is rejected. The simplest tier that clears the
 * active deterministic gates WITHIN the style complexity ceiling wins; an over-budget pass is
 * retained only as diagnostic repair input and never reported as a lockable seed.
 */
export async function derivePhaseSeed(workspaceInput: string, options: DeriveOptions = {}): Promise<DeriveResult> {
  const { resumeWorkspace } = await import("./workspace.js");
  const workspace = await resumeWorkspace(workspaceInput);
  const state = await loadTaskState(workspace.layout.internal.state);
  if (state.authorshipMode !== "derived") throw new Error("derive requires authorshipMode \"derived\"; independent workspaces must not consume source topology");
  const phase = state.activePhase;
  const route = phaseOperator(phase);
  if (!route) {
    return { status: "not-supported", phase, operator: "none", tiers: [], note: `derive supports hull, turret, gun, running-gear, and tracks; active phase is ${phase}` };
  }
  const preparation = await verifyWorkspaceOraclePreparation(workspace);
  const oracle = await loadPreparedOracle(preparation.manifest, workspace.root);
  const snapshot = snapshotScene(oracle);
  const authoritativeDimensions = preparation.manifest.authoritativeDimensions ?? undefined;

  // Live candidate context for composition: audited under CURRENT trust authority.
  const liveCandidateIdentity = await verifyWorkspaceCandidateIdentity(workspace, await trustedGeneratedAuditOptions(workspace, preparation.binding.identity));

  let seed: PhaseSeed;
  const analytic = route.operator !== "mesh-simplify";
  if (route.operator === "mesh-simplify") {
    seed = await buildMeshSimplifySeed(snapshot, phase);
  } else if (route.operator === "radial-fit") {
    const built = buildRadialSeed(snapshot);
    if (!built.nodes.length) throw new Error("prepared oracle carries no running-gear instances to derive from");
    seed = {
      name: "running-gear",
      inputGeometryHash: sha256(canonicalJson(built.nodes.map((node) => ({ id: node.semanticId, radiusBounds: measureWheelRadialProfile(snapshot, node.semanticId)?.meanRadius ?? null })))),
      inputTriangles: built.inputTriangles,
      simplify: async () => ({ nodes: built.nodes }),
    };
  } else if (route.operator === "course-regenerate") {
    const built = buildTrackSeed(snapshot);
    if (!built.nodes.length) throw new Error("prepared oracle carries no track courses to derive from");
    seed = {
      name: "tracks",
      inputGeometryHash: sha256(canonicalJson(built.nodes.map((node) => ({ id: node.semanticId, indices: node.indices!.length })))),
      inputTriangles: built.inputTriangles,
      simplify: async () => ({ nodes: built.nodes }),
    };
  } else {
    const built = buildGunSeed(snapshot);
    seed = {
      name: "gun",
      inputGeometryHash: geometryBytesHash(built.nodes[1]!.positions!, built.nodes[1]!.indices!),
      inputTriangles: built.inputTriangles,
      simplify: async () => ({ nodes: built.nodes }),
    };
  }

  const triangleMax = workspace.styleContract.complexity.triangleMax;
  const meshMax = workspace.styleContract.complexity.meshMax;

  const tierResults: DeriveTierResult[] = [];
  const evaluatedNodes = new Map<DeriveTierResultTier, SeedNode[]>();
  for (const tier of tiersForQuality(options.quality, analytic)) {
    const built = await seed.simplify(tier.ratio, tier.error);
    const outputTriangles = built.nodes.reduce((sum, node) => sum + (node.indices?.length ?? 0) / 3, 0);
    if (!outputTriangles) continue;
    const replacement = buildSeedGroup(seed.name, built.nodes);
    const composed: ComposedCandidateRuntime = composeCandidateForPhase({
      profile: workspace.project.profile,
      phase,
      liveCandidate: liveCandidateIdentity.runtime,
      replacement,
    });
    let verdict: Awaited<ReturnType<typeof evaluateComposedCandidate>>;
    try {
      verdict = await evaluateComposedCandidate(workspace, phase, oracle, authoritativeDimensions, composed);
    } finally {
      composed.dispose();
    }
    evaluatedNodes.set(tier.tier, built.nodes);
    const withinBudget = verdict.triangles <= triangleMax && verdict.meshes <= meshMax;
    tierResults.push({
      tier: tier.tier,
      triangles: outputTriangles,
      passed: verdict.passed,
      score: verdict.score,
      failingGates: verdict.failingGates,
      withinComplexityBudget: withinBudget,
      ...(built.error !== undefined ? { simplifierError: built.error } : {}),
    });
    if (verdict.passed && withinBudget) break;
  }

  const { status, reasonCode, chosen } = resolveSeedOutcome(tierResults);
  if (!chosen) throw new Error("no derive tier produced usable geometry for the active phase");
  const builtNodes = evaluatedNodes.get(chosen.tier)!;

  const outputHash = sha256(canonicalJson(builtNodes.filter((node) => node.kind === "mesh").map((node) => ({ id: node.semanticId, geometryHash: geometryBytesHash(node.positions!, node.indices!) }))));
  const moduleSource = emitGeneratedModule(seed.name, builtNodes);
  const manifest: DerivationManifest = {
    schemaVersion: 1,
    kind: "mesh2threejs-derived-seed",
    phase,
    oraclePreparationIdentity: preparation.binding.identity,
    preparedOracleHash: preparation.binding.preparedHash,
    operator: route.operator,
    recipe: {
      tier: chosen.tier,
      ...(chosen.simplifierError !== undefined ? { simplifierError: chosen.simplifierError } : {}),
      ...(analytic ? {} : { ladder: TIERS.filter(({ ratio }) => ratio !== undefined).map(({ tier, ratio }) => ({ tier, ratio })) }),
    },
    inputGeometryHash: seed.inputGeometryHash,
    outputGeometryHash: outputHash,
    generatedModulePath: `${GENERATED_DIRECTORY}/${seed.name}.mjs`,
    generatedModuleHash: sha256(Buffer.from(moduleSource, "utf8")),
    inputTriangles: seed.inputTriangles,
    outputTriangles: chosen.triangles,
    ...(chosen.simplifierError !== undefined ? { simplifierError: chosen.simplifierError } : {}),
  };

  let workorders: Workorder[] | undefined;
  if (status !== "seed-passing") {
    try {
      const subjectContract = workspace.resolved.subjectContract
        ? JSON.parse(await readFile(workspace.resolved.subjectContract, "utf8")) as GenericSubjectContract
        : undefined;
      const replacement = buildSeedGroup(seed.name, builtNodes);
      const composed = composeCandidateForPhase({ profile: workspace.project.profile, phase, liveCandidate: liveCandidateIdentity.runtime, replacement });
      let evaluation;
      try {
        evaluation = await evaluateCandidateWithPoses({
          oracle,
          candidate: composed,
          profile: workspace.project.profile,
          style: workspace.styleContract,
          certification: workspace.state.certification,
          ...(authoritativeDimensions ? { authoritativeDimensions: authoritativeDimensions as { hullLength: number; overallLength: number; width: number; height: number } } : {}),
          ...(subjectContract ? { subjectContract } : {}),
          phase,
        });
      } finally {
        composed.dispose();
      }
      workorders = evaluation.phaseGates[phase]?.workorders ?? [];
      if (status === "seed-diagnostic-overbudget") {
        workorders = [{
          component: "style-complexity",
          errorKind: "derive.over-budget-fallback",
          priority: "critical",
          correction: `derived ${chosen.tier} geometry clears the active gates but the composed candidate exceeds the style ceiling (${triangleMax} triangles / ${meshMax} meshes); simplify the representation further or lower derive quality`,
          phase,
        }, ...workorders];
      }
    } catch { /* retain without workorder detail */ }
  }

  const written = await writeDerivedArtifacts(workspace, manifest, moduleSource);
  const wiring = await wireGeneratedComposition(workspace, orderedDerivedPhases(workspace.project.profile, await readAllManifests(workspace)));

  const nextState = await loadTaskState(workspace.layout.internal.state);
  nextState.derivedBindings[manifest.generatedModulePath] = {
    manifestHash: derivationManifestHash(manifest),
    generatedModuleHash: manifest.generatedModuleHash,
    oraclePreparationIdentity: manifest.oraclePreparationIdentity,
  };
  nextState.systemDecisions.push({
    id: `derived-seed-${nextState.systemDecisions.length + 1}`,
    value: manifest.generatedModulePath,
    reason: `derive produced a ${chosen.tier} ${route.operator} seed for phase ${phase} (${seed.inputTriangles} -> ${chosen.triangles} triangles, status ${status})`,
  });
  await saveTaskState(workspace.layout.internal.state, nextState);
  // The live candidate changed (new generated module bytes plus regenerated registry);
  // prove it audits and loads cleanly under the CURRENT trust authority before reporting.
  await verifyWorkspaceCandidateIdentity(workspace, await trustedGeneratedAuditOptions(workspace, preparation.binding.identity));

  const note = status === "seed-passing"
    ? undefined
    : status === "seed-diagnostic-overbudget"
      ? "the retained seed passes active gates but exceeds the style complexity ceiling; it is diagnostic repair input only and must be simplified before locking"
      : "no tier cleared the active gates; the highest-scoring tier was retained with its failing workorders";
  return {
    status,
    ...(reasonCode ? { reasonCode } : {}),
    phase,
    operator: route.operator,
    generatedModule: relative(workspace.root, written.modulePath).replaceAll("\\", "/"),
    manifest: relative(workspace.root, written.manifestPath).replaceAll("\\", "/"),
    tiers: tierResults,
    ...(status === "seed-passing" ? { selected: chosen } : {}),
    ...(workorders ? { workorders } : {}),
    ...(wiring ? { wiring } : {}),
    ...(note ? { note } : {}),
  };
}

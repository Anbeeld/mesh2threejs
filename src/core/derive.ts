import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { join } from "node:path";
import * as THREE from "three";
import { MeshoptSimplifier } from "meshoptimizer";
import type { ResumedWorkspace } from "./workspace.js";
import { MODEL_SCAFFOLD, verifyWorkspaceCandidateIdentity, verifyWorkspaceOraclePreparation } from "./workspace.js";
import { loadPreparedOracle } from "./oracle.js";
import { loadTaskState, saveTaskState } from "./state.js";
import { canonicalJson, sha256 } from "./hashing.js";
import { snapshotScene } from "./geometry.js";
import { measureBounds, measureWheelRadialProfile } from "./measurement.js";
import { evaluateCandidateWithPoses } from "./orchestration.js";
import { derivedDirectory, derivationManifestHash, loadTrustedGeneratedModules, type DerivationManifest } from "./derivation.js";
import type { GenericSubjectContract } from "../profiles/generic.js";
import type { Bounds3, CandidateRuntime, Point3, SceneSnapshot, Workorder } from "../types.js";

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
  simplifierError?: number;
}

export type DeriveTierResultTier = "aggressive" | "balanced" | "conservative" | "source-cleaned";

export interface DeriveResult {
  status: "seed-passing" | "seed-retained-failing" | "not-supported";
  phase: string;
  operator: string;
  generatedModule?: string;
  manifest?: string;
  tiers: DeriveTierResult[];
  selected?: DeriveTierResult;
  workorders?: Workorder[];
  wiring?: "wrote-model-scaffold" | "manual-wiring-required";
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

interface SeedMesh {
  semanticId: string;
  role?: string;
  positions: Float32Array;
  indices: Uint32Array;
}

interface SeedPivot {
  semanticId: string;
  origin: Point3;
}

/** Emits the pipeline-owned generated module bytes for one derived phase seed. */
function emitGeneratedModule(name: string, meshes: SeedMesh[], pivots: SeedPivot[]): string {
  const lines: string[] = [];
  lines.push(`import * as THREE from "three";`);
  lines.push(``);
  lines.push(`// Generated by mesh2threejs derive — trusted pipeline tool output.`);
  lines.push(`// Provenance: .mesh2threejs/derived/${name}.json (do not edit by hand).`);
  for (const [index, mesh] of meshes.entries()) {
    lines.push(`const P${index} = new Float32Array([${roundList(mesh.positions).join(",")}]);`);
    lines.push(`const I${index} = new Uint32Array([${Array.from(mesh.indices).join(",")}]);`);
  }
  lines.push(``);
  lines.push(`export function createSeed() {`);
  lines.push(`  const group = new THREE.Group();`);
  lines.push(`  group.name = ${JSON.stringify(`derived-${name}`)};`);
  for (const pivot of pivots) {
    lines.push(`  {`);
    lines.push(`    const marker = new THREE.Group();`);
    lines.push(`    marker.name = ${JSON.stringify(pivot.semanticId)};`);
    lines.push(`    marker.userData.semanticId = ${JSON.stringify(pivot.semanticId)};`);
    lines.push(`    marker.position.set(${pivot.origin.map((value) => Number(value.toFixed(6))).join(", ")});`);
    lines.push(`    group.add(marker);`);
    lines.push(`  }`);
  }
  for (const [index, mesh] of meshes.entries()) {
    lines.push(`  {`);
    lines.push(`    const geometry = new THREE.BufferGeometry();`);
    lines.push(`    geometry.setAttribute("position", new THREE.BufferAttribute(P${index}, 3));`);
    lines.push(`    geometry.setIndex(new THREE.BufferAttribute(I${index}, 1));`);
    lines.push(`    geometry.computeVertexNormals();`);
    lines.push(`    const material = new THREE.MeshStandardMaterial({ color: 0x6b7358, roughness: 0.7 });`);
    lines.push(`    material.flatShading = true;`);
    lines.push(`    const mesh = new THREE.Mesh(geometry, material);`);
    lines.push(`    mesh.name = ${JSON.stringify(mesh.semanticId)};`);
    lines.push(`    mesh.userData.semanticId = ${JSON.stringify(mesh.semanticId)};`);
    if (mesh.role) lines.push(`    mesh.userData.semanticRole = ${JSON.stringify(mesh.role)};`);
    lines.push(`    group.add(mesh);`);
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

/** Builds the analytic radial-fit seed: one low-segment closed radial wheel per measured instance. */
function buildRadialSeed(snapshot: SceneSnapshot): { moduleMeshes: SeedMesh[]; inputTriangles: number } {
  const moduleMeshes: SeedMesh[] = [];
  let inputTriangles = 0;
  for (const component of Object.values(snapshot.components)) {
    const role = wheelRole(component.id, component.role);
    if (!role || !component.triangleIndices.length) continue;
    inputTriangles += component.triangleIndices.length;
    const profile = measureWheelRadialProfile(snapshot, component.id);
    const radius = profile ? Math.max(profile.meanRadius, 1e-3) : Math.max(Math.hypot(component.bounds.size[1], component.bounds.size[2]) / 2, 1e-3);
    const width = Math.max(component.bounds.size[0], component.bounds.size[1] * 0.25, 1e-3);
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
    moduleMeshes.push({ semanticId: component.id, role, positions: Float32Array.from(positions), indices: Uint32Array.from(indices) });
  }
  return { moduleMeshes, inputTriangles };
}

/**
 * Builds the course-regenerate seed: one continuous low-poly course per measured track,
 * matching the measured envelope (length along Z, height along Y, width along X).
 */
function buildTrackSeed(snapshot: SceneSnapshot): { moduleMeshes: SeedMesh[]; inputTriangles: number } {
  const moduleMeshes: SeedMesh[] = [];
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
      points.push([left + radius, bottom]);
      points.push([right - radius, bottom]);
      arc(right - radius, bottom + radius, -Math.PI / 2, 4);
      points.push([right, top - radius]);
      arc(right - radius, top - radius, 0, 4);
      points.push([left + radius, top]);
      arc(left + radius, top - radius, Math.PI / 2, 4);
      points.push([left, bottom + radius]);
      arc(left + radius, bottom + radius, Math.PI, 4);
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
    moduleMeshes.push({ semanticId: component.id, role: component.role ?? "track-course", positions: Float32Array.from(positions), indices: Uint32Array.from(indices) });
  }
  return { moduleMeshes, inputTriangles };
}

/**
 * Builds the axis-fit gun seed: the measured pivot anchor, neutral barrel direction, barrel
 * length, and an 80th-percentile perpendicular radius drive one low-segment capped tube.
 */
function buildGunSeed(snapshot: SceneSnapshot): { pivots: SeedPivot[]; moduleMeshes: SeedMesh[]; inputTriangles: number } {
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
  const length = Math.hypot(...vector);
  const direction = vector.map((value) => value / Math.max(length, 1e-9)) as Point3;
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
  const positions: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring < 2; ring += 1) {
    const along = (ring - 0.3) * length;
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const cos = Math.cos(angle) * radius;
      const sin = Math.sin(angle) * radius;
      positions.push(
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
  for (let segment = 1; segment < segments - 1; segment += 1) indices.push(0, segment + 1, segment + 2);
  const capBase = segments;
  for (let segment = 1; segment < segments - 1; segment += 1) indices.push(capBase, capBase + segment + 1, capBase + segment + 2);
  return {
    pivots: [{ semanticId: "gun-pivot", origin: pivotOrigin }],
    moduleMeshes: [{ semanticId: "gun", positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }],
    inputTriangles: gun.triangleIndices.length,
  };
}

interface PhaseSeed {
  name: string;
  pivots: SeedPivot[];
  inputGeometryHash: string;
  inputTriangles: number;
  simplify: (ratio: number | undefined, error: number | undefined) => Promise<{ meshes: SeedMesh[]; error?: number }>;
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
  const pivots: SeedPivot[] = [];
  if (phase === "turret") {
    const marker = snapshot.components["turret-pivot"];
    if (marker?.origin) pivots.push({ semanticId: "turret-pivot", origin: marker.origin });
  }
  return {
    name: phase.replace(/[^a-z0-9]+/giu, "-").toLowerCase(),
    pivots,
    inputGeometryHash,
    inputTriangles,
    simplify: async (ratio, error) => {
      const meshes: SeedMesh[] = [];
      let simplifierError: number | undefined;
      for (const [id, cleaned] of [...cleanedPerSemantic].sort(([a], [b]) => a.localeCompare(b))) {
        const result = await simplifyMesh(cleaned.positions, cleaned.indices, ratio, error);
        if (result.error !== undefined) simplifierError = Math.max(simplifierError ?? 0, result.error);
        meshes.push({ semanticId: id, positions: result.positions, indices: result.indices });
      }
      return { meshes, ...(simplifierError !== undefined ? { error: simplifierError } : {}) };
    },
  };
}

function buildSeedGroup(name: string, pivots: SeedPivot[], meshes: SeedMesh[]): THREE.Group {
  const group = new THREE.Group();
  group.name = `derived-${name}`;
  for (const pivot of pivots) {
    const marker = new THREE.Group();
    marker.name = pivot.semanticId;
    marker.userData.semanticId = pivot.semanticId;
    marker.position.set(...pivot.origin);
    group.add(marker);
  }
  for (const mesh of meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0x6b7358, roughness: 0.7 });
    material.flatShading = true;
    const object = new THREE.Mesh(geometry, material);
    object.name = mesh.semanticId;
    object.userData.semanticId = mesh.semanticId;
    if (mesh.role) object.userData.semanticRole = mesh.role;
    group.add(object);
  }
  return group;
}

/** Evaluates one seed tier through the real active-phase deterministic gate path. */
async function evaluateSeed(workspace: ResumedWorkspace, phase: string, oracle: THREE.Object3D, authoritativeDimensions: Record<string, number> | undefined, seedRoot: THREE.Object3D): Promise<{ passed: boolean; score: number; failingGates: Array<{ code: string; score: number; message: string }> }> {
  const subjectContract = workspace.resolved.subjectContract
    ? JSON.parse(await readFile(workspace.resolved.subjectContract, "utf8")) as GenericSubjectContract
    : undefined;
  const candidateRuntime: CandidateRuntime = { root: seedRoot, setPose: () => {} };
  const evaluation = await evaluateCandidateWithPoses({
    oracle,
    candidate: candidateRuntime,
    profile: workspace.project.profile,
    style: workspace.styleContract,
    certification: workspace.state.certification,
    ...(authoritativeDimensions ? { authoritativeDimensions: authoritativeDimensions as { hullLength: number; overallLength: number; width: number; height: number } } : {}),
    ...(subjectContract ? { subjectContract } : {}),
    phase,
  });
  const phaseReport = evaluation.phaseGates[phase];
  return {
    passed: evaluation.passed && Boolean(phaseReport?.passed),
    score: phaseReport?.score ?? evaluation.contractGates.score,
    failingGates: [
      ...evaluation.deterministic.rows.filter((row) => !row.passed).map((row) => ({ code: row.code, score: row.score, message: row.message })),
      ...Object.values(evaluation.phaseGates).flatMap((report) => report.rows.filter((row) => !row.passed).map((row) => ({ code: row.code, score: row.score, message: row.message }))),
    ],
  };
}

async function writeDerivedArtifacts(workspace: ResumedWorkspace, manifest: DerivationManifest, moduleSource: string): Promise<{ modulePath: string; manifestPath: string }> {
  const modulePath = resolve(workspace.root, manifest.generatedModulePath);
  await mkdir(resolve(workspace.root, "model/.generated"), { recursive: true });
  await writeFile(modulePath, moduleSource);
  const manifestDirectory = derivedDirectory(workspace.layout.internal.root);
  await mkdir(manifestDirectory, { recursive: true });
  const manifestPath = join(manifestDirectory, `${manifest.phase}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { modulePath, manifestPath };
}

/** Rewrites an untouched model scaffold to compose every recorded generated seed module. */
async function wireModelScaffold(workspace: ResumedWorkspace, manifests: DerivationManifest[]): Promise<"wrote-model-scaffold" | "manual-wiring-required"> {
  const modelEntryPath = resolve(workspace.root, workspace.project.model);
  const current = await readFile(modelEntryPath, "utf8");
  if (current.trim() !== MODEL_SCAFFOLD.trim()) return "manual-wiring-required";
  const ordered = [...manifests].sort((a, b) => a.generatedModulePath.localeCompare(b.generatedModulePath));
  const identifier = (phase: string): string => `createSeed${phase.replace(/[^a-z0-9]+/giu, "")}`;
  const lines: string[] = [`import * as THREE from "three";`];
  for (const manifest of ordered) {
    lines.push(`import { createSeed as ${identifier(manifest.phase)} } from "./.generated/${manifest.phase}.mjs";`);
  }
  lines.push(``);
  lines.push(`export function createCandidate() {`);
  lines.push(`  const root = new THREE.Group();`);
  lines.push(`  root.name = "candidate";`);
  for (const manifest of ordered) lines.push(`  root.add(${identifier(manifest.phase)}());`);
  lines.push(`  return {`);
  lines.push(`    root,`);
  lines.push(`    setPose() {},`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push(``);
  await writeFile(modelEntryPath, lines.join("\n"));
  return "wrote-model-scaffold";
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

/** Trusted-audit options bound to the CURRENT preparation for workspace commands. */
export async function trustedGeneratedAuditOptions(workspace: ResumedWorkspace, identity?: string): Promise<{ trustedGeneratedModules: Map<string, unknown> }> {
  const preparationIdentity = identity ?? (await verifyWorkspaceOraclePreparation(workspace)).binding.identity;
  const trusted = await loadTrustedGeneratedModules(derivedDirectory(workspace.layout.internal.root), workspace.root, preparationIdentity);
  return { trustedGeneratedModules: trusted };
}

/**
 * Creates the best cheap source-derived seed for the active builder phase, selects the
 * simplest tier that clears the active deterministic gates, writes the trusted generated
 * module plus its provenance manifest, and binds both into durable state.
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

  let seed: PhaseSeed;
  const analytic = route.operator !== "mesh-simplify";
  if (route.operator === "mesh-simplify") {
    seed = await buildMeshSimplifySeed(snapshot, phase);
  } else if (route.operator === "radial-fit") {
    const built = buildRadialSeed(snapshot);
    if (!built.moduleMeshes.length) throw new Error("prepared oracle carries no running-gear instances to derive from");
    seed = {
      name: "running-gear",
      pivots: [],
      inputGeometryHash: sha256(canonicalJson(built.moduleMeshes.map((mesh) => ({ id: mesh.semanticId, radiusBounds: measureWheelRadialProfile(snapshot, mesh.semanticId)?.meanRadius ?? null })))),
      inputTriangles: built.inputTriangles,
      simplify: async () => ({ meshes: built.moduleMeshes }),
    };
  } else if (route.operator === "course-regenerate") {
    const built = buildTrackSeed(snapshot);
    if (!built.moduleMeshes.length) throw new Error("prepared oracle carries no track courses to derive from");
    seed = {
      name: "tracks",
      pivots: [],
      inputGeometryHash: sha256(canonicalJson(built.moduleMeshes.map((mesh) => ({ id: mesh.semanticId, bounds: mesh.indices.length })))),
      inputTriangles: built.inputTriangles,
      simplify: async () => ({ meshes: built.moduleMeshes }),
    };
  } else {
    const built = buildGunSeed(snapshot);
    seed = {
      name: "gun",
      pivots: built.pivots,
      inputGeometryHash: geometryBytesHash(built.moduleMeshes[0]!.positions, built.moduleMeshes[0]!.indices),
      inputTriangles: built.inputTriangles,
      simplify: async () => ({ meshes: built.moduleMeshes }),
    };
  }

  const tierResults: DeriveTierResult[] = [];
  const evaluated = new Map<DeriveTierResultTier, { meshes: SeedMesh[]; error?: number }>();
  for (const tier of tiersForQuality(options.quality, analytic)) {
    const built = await seed.simplify(tier.ratio, tier.error);
    const outputTriangles = built.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0);
    if (!outputTriangles) continue;
    evaluated.set(tier.tier, built);
    const verdict = await evaluateSeed(workspace, phase, oracle, authoritativeDimensions, buildSeedGroup(seed.name, seed.pivots, built.meshes));
    tierResults.push({ tier: tier.tier, triangles: outputTriangles, passed: verdict.passed, score: verdict.score, failingGates: verdict.failingGates, ...(built.error !== undefined ? { simplifierError: built.error } : {}) });
    if (verdict.passed) break;
  }

  const passing = tierResults.find((tier) => tier.passed);
  const retained = tierResults.reduce((best, tier) => (!best || tier.score > best.score ? tier : best), tierResults[0]);
  const chosen = passing ?? retained;
  if (!chosen) throw new Error("no derive tier produced usable geometry for the active phase");
  const status: DeriveResult["status"] = passing ? "seed-passing" : "seed-retained-failing";
  const built = evaluated.get(chosen.tier)!;

  const outputHash = sha256(canonicalJson(built.meshes.map((mesh) => ({ id: mesh.semanticId, geometryHash: geometryBytesHash(mesh.positions, mesh.indices) }))));
  const moduleSource = emitGeneratedModule(seed.name, built.meshes, seed.pivots);
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
    generatedModulePath: `model/.generated/${seed.name}.mjs`,
    generatedModuleHash: sha256(Buffer.from(moduleSource, "utf8")),
    inputTriangles: seed.inputTriangles,
    outputTriangles: chosen.triangles,
    ...(chosen.simplifierError !== undefined ? { simplifierError: chosen.simplifierError } : {}),
  };

  let workorders: Workorder[] | undefined;
  if (!passing) {
    try {
      const subjectContract = workspace.resolved.subjectContract
        ? JSON.parse(await readFile(workspace.resolved.subjectContract, "utf8")) as GenericSubjectContract
        : undefined;
      const evaluation = await evaluateCandidateWithPoses({
        oracle,
        candidate: { root: buildSeedGroup(seed.name, seed.pivots, built.meshes), setPose: () => {} } satisfies CandidateRuntime,
        profile: workspace.project.profile,
        style: workspace.styleContract,
        certification: workspace.state.certification,
        ...(authoritativeDimensions ? { authoritativeDimensions: authoritativeDimensions as { hullLength: number; overallLength: number; width: number; height: number } } : {}),
        ...(subjectContract ? { subjectContract } : {}),
        phase,
      });
      workorders = evaluation.phaseGates[phase]?.workorders ?? [];
    } catch { /* retain without workorder detail */ }
  }

  const written = await writeDerivedArtifacts(workspace, manifest, moduleSource);
  const wiring = await wireModelScaffold(workspace, await readAllManifests(workspace));

  const nextState = await loadTaskState(workspace.layout.internal.state);
  nextState.derivedBindings[manifest.generatedModulePath] = {
    manifestHash: derivationManifestHash(manifest),
    generatedModuleHash: manifest.generatedModuleHash,
    oraclePreparationIdentity: manifest.oraclePreparationIdentity,
  };
  nextState.systemDecisions.push({
    id: `derived-seed-${nextState.systemDecisions.length + 1}`,
    value: manifest.generatedModulePath,
    reason: `derive produced a ${chosen.tier} ${route.operator} seed for phase ${phase} (${seed.inputTriangles} -> ${chosen.triangles} triangles)`,
  });
  await saveTaskState(workspace.layout.internal.state, nextState);
  // The live candidate changed (new generated module bytes plus possibly rewritten scaffold);
  // prove it audits and loads cleanly under the CURRENT preparation binding before reporting.
  await verifyWorkspaceCandidateIdentity(workspace, await trustedGeneratedAuditOptions(workspace, preparation.binding.identity));

  return {
    status,
    phase,
    operator: route.operator,
    generatedModule: relative(workspace.root, written.modulePath).replaceAll("\\", "/"),
    manifest: relative(workspace.root, written.manifestPath).replaceAll("\\", "/"),
    tiers: tierResults,
    ...(passing ? { selected: passing } : {}),
    ...(workorders ? { workorders } : {}),
    wiring,
    ...(status === "seed-retained-failing" ? { note: "no tier cleared the active gates; the highest-scoring tier was retained with its failing workorders" } : {}),
  };
}

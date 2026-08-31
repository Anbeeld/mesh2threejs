import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { join } from "node:path";
import * as THREE from "three";
import { MeshoptSimplifier } from "meshoptimizer";
import type { ResumedWorkspace } from "./workspace.js";
import { MODEL_DERIVED_SCAFFOLD, MODEL_SCAFFOLD, verifyWorkspaceOraclePreparation } from "./workspace.js";
import { loadPreparedOracle } from "./oracle.js";
import { loadTaskState, saveTaskState } from "./state.js";
import { canonicalJson, sha256 } from "./hashing.js";
import { snapshotScene } from "./geometry.js";
import { measureBounds, measureWheelRadialProfile } from "./measurement.js";
import { requiredPosesForProfile, neutralPoseForProfile } from "./orchestration.js";
import { getProfileContract } from "./contracts.js";
import {
  GENERATED_DIRECTORY,
  GENERATED_REGISTRY_PATH,
  REPAIRS_DIRECTORY,
  assertNoExecutableRepairs,
  derivedDirectory,
  derivationManifestHash,
  discoverRepairs,
  generateRegistrySource,
  loadTrustedGeneratedModules,
  orderedDerivedPhasesFromBindings,
  repairBinding,
  verifyDerivedLineage,
  type DerivationManifest,
} from "./derivation.js";
import { applyRepairSpec, validateRepairSpec, type DerivedRepairSpec } from "./repair-spec.js";
import { assertAssemblyCoverage } from "./assembly.js";
import { phaseOwnedSemantics } from "./phase-compose.js";
import type { GenericSubjectContract } from "../profiles/generic.js";
import type { TaskState } from "./state.js";
import type { Bounds3, CandidateRuntime, Point3, ProfileId, SceneSnapshot, Workorder } from "../types.js";

export type DeriveQuality = "aggressive" | "balanced" | "conservative";

export interface DeriveOptions {
  quality?: DeriveQuality;
  /**
   * Trusted-run persistence hook: when present, durable derived-binding state mutations are
   * applied through this callback (which routes them through the canonical run authority)
   * instead of being written directly to the workspace state file. Receives the freshly
   * loaded workspace state and returns the next durable state.
   */
  persistState?: (state: TaskState) => Promise<TaskState>;
  /**
   * Explicit sandbox backend for trial composition evaluation. Development callers pass the
   * in-process backend; trusted callers MUST pass a bounded child backend (remaining
   * closure §2.7) so tier trials never execute inside the broker process.
   */
  backend?: import("./candidate-sandbox.js").SandboxBackend;
  /**
   * Broker-private execution scratch root (final closure §2). Trusted callers pass this so
   * tier-trial staging lives outside the workspace/repo; development callers omit it.
   */
  executionScratchRoot?: string;
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
  /** Required-phase-gate summary used to rank failing tiers diagnostically. A shared binary
   * zero row (e.g. connectivity) collapses the phase minimum for every tier, so retention of
   * the most informative failing tier must not rely on that minimum alone. */
  diagnostic?: TierDiagnostic;
}

export interface TierDiagnostic {
  /** Required phase contract gates that passed. */
  passedGateCount: number;
  /** Total required phase contract gates evaluated. */
  gateCount: number;
  /** Mean required-gate score (0..100). */
  meanGateScore: number;
  /** Lowest individual required-gate score above the binary zero floor; equals gateCount when
   * every required gate is fully blocked (pure-binary failure). */
  minFidelityGateScore: number;
}

export type DeriveTierResultTier = "componentwise-aggressive" | "componentwise-balanced" | "componentwise-conservative" | "source-preserve";

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

/**
 * Deterministic seed route per active builder phase. Source selection uses the SINGLE
 * authoritative profile phase-ownership resolver shared with phase scope, composition, and
 * hashing â€” never a phase-specific hard-coded predicate (Â§11.2).
 */
function phaseOperator(profile: ProfileId, phase: string): { operator: DerivationManifest["operator"]; semantics: (id: string, role?: string) => boolean; label: string } | null {
  const ownership = phaseOwnedSemantics(profile, phase);
  if (phase === "hull" || phase === "turret") return { operator: "mesh-simplify", semantics: ownership ?? (() => false), label: phase };
  if (phase === "gun") return { operator: "axis-fit", semantics: () => false, label: "gun" };
  if (phase === "running-gear") return { operator: "radial-fit", semantics: ownership ?? (() => false), label: "running gear" };
  if (phase === "tracks") return { operator: "course-regenerate", semantics: ownership ?? (() => false), label: "tracks" };
  return null;
}

const TIERS: ReadonlyArray<{ tier: DeriveTierResultTier; ratio?: number; error?: number }> = [
  { tier: "componentwise-aggressive", ratio: 0.02, error: 0.05 },
  { tier: "componentwise-balanced", ratio: 0.05, error: 0.03 },
  { tier: "componentwise-conservative", ratio: 0.12, error: 0.01 },
  { tier: "source-preserve" },
];

function tiersForQuality(quality: DeriveQuality | undefined, analytic: boolean): ReadonlyArray<{ tier: DeriveTierResultTier; ratio?: number; error?: number }> {
  // Analytic routes regenerate primitives deterministically; there is exactly one recipe.
  if (analytic) return TIERS.slice(-1);
  const requested = quality ? `componentwise-${quality}` as DeriveTierResultTier : undefined;
  const index = requested ? TIERS.findIndex((tier) => tier.tier === requested) : -1;
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
function collectSemantics(snapshot: SceneSnapshot, predicate: (id: string, role?: string) => boolean): Map<string, TriangleSoup> {
  const soups = new Map<string, TriangleSoup>();
  for (const component of Object.values(snapshot.components)) {
    if (!predicate(component.id, component.role) || !component.triangleIndices.length) continue;
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
 * When uncertain, the component is kept â€” the simplifier can shed complexity later.
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
  /** Style-compatible material parameters (declarative repairs only). */
  material?: { color?: readonly [number, number, number]; roughness?: number; metalness?: number; flatShading?: boolean };
  /**
   * Emit this mesh WITHOUT its own userData.semanticId (pipeline remediation plan E2):
   * runtime snapshot attribution walks to the owning ancestor semantic group, so the
   * geometry becomes INTRINSIC geometry of that pivot semantic. Used by component-keep to
   * preserve source geometry owned by an articulation pivot while the pivot remains a
   * transform group. The node keeps an internal object name for attachment only; it must
   * never declare a duplicate semantic ID.
   */
  attributeToParent?: boolean;
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
    const material = new THREE.MeshStandardMaterial({
      color: node.material?.color ? new THREE.Color(...node.material.color) : 0x6b7358,
      roughness: node.material?.roughness ?? 0.7,
      ...(node.material?.metalness !== undefined ? { metalness: node.material.metalness } : {}),
    });
    material.flatShading = node.material?.flatShading ?? true;
    const object = new THREE.Mesh(geometry, material);
    object.name = node.semanticId;
    if (!node.attributeToParent) {
      object.userData.semanticId = node.semanticId;
      if (node.role) object.userData.semanticRole = node.role;
    }
    attach(object, node.parentSemanticId);
  }
  return group;
}

/** Emits the pipeline-owned generated module bytes for one derived phase seed. */
function emitGeneratedModule(name: string, nodes: SeedNode[]): string {
  const lines: string[] = [];
  lines.push(`import * as THREE from "three";`);
  lines.push(``);
  lines.push(`// Generated by mesh2threejs derive â€” trusted pipeline tool output.`);
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
    const materialColor = node.material?.color ? `new THREE.Color(${node.material.color.map((value) => Number(value.toFixed(5))).join(", ")})` : "0x6b7358";
    lines.push(`    const material = new THREE.MeshStandardMaterial({ color: ${materialColor}, roughness: ${node.material?.roughness ?? 0.7}${node.material?.metalness !== undefined ? `, metalness: ${node.material.metalness}` : ""} });`);
    lines.push(`    material.flatShading = ${node.material?.flatShading ?? true};`);
    lines.push(`    const mesh = new THREE.Mesh(geometry, material);`);
    lines.push(`    mesh.name = ${JSON.stringify(node.semanticId)};`);
    if (node.attributeToParent) {
      // Pivot-owned kept geometry: NO duplicate userData.semanticId; the ancestor pivot
      // semantic owns these triangles at runtime snapshot attribution.
    } else {
      lines.push(`    mesh.userData.semanticId = ${JSON.stringify(node.semanticId)};`);
      if (node.role) lines.push(`    mesh.userData.semanticRole = ${JSON.stringify(node.role)};`);
    }
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
      // 7.5Â° granularity and demands near-source diversity, so the arc must place at
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
function buildGunSeed(snapshot: SceneSnapshot, keepTargets: ReadonlySet<string> = new Set()): { nodes: SeedNode[]; inputTriangles: number } {
  const pivotComponent = snapshot.components["gun-pivot"];
  const gun = snapshot.components.gun;
  if (!gun || !gun.triangleIndices.length) throw new Error("prepared oracle carries no gun geometry to fit");
  // component-keep applicability for the axis-fit route (pipeline remediation plan E2):
  // the ONLY droppable geometry on this route is source geometry intrinsically owned by the
  // gun-pivot semantic. Anything else can never affect the seed and must fail clearly.
  for (const target of keepTargets) {
    if (target === "gun") {
      throw new Error(`component-keep target "gun" cannot affect the axis-fit gun seed: the barrel is fitted unconditionally from the gun semantics`);
    }
    if (target !== "gun-pivot" || !pivotComponent) {
      throw new Error(`component-keep target "${target}" is not a semantic owned by phase gun that the axis-fit seed can keep (only "gun-pivot" owns droppable geometry)`);
    }
    if (!pivotComponent.triangleIndices.length) {
      throw new Error(`component-keep target "gun-pivot" owns no intrinsic oracle geometry to preserve; the keep marker would be inert`);
    }
  }
  const keepPivotGeometry = keepTargets.has("gun-pivot") && Boolean(pivotComponent?.triangleIndices.length);
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
  const nodes: SeedNode[] = [
    { semanticId: "gun-pivot", kind: "group", position: pivotOrigin },
    { semanticId: "gun", kind: "mesh", parentSemanticId: "gun-pivot", positions: localPositions(Float32Array.from(world), pivotOrigin), indices: Uint32Array.from(indices) },
  ];
  if (keepPivotGeometry) {
    // component-keep(gun-pivot): emit the pivot's INTRINSIC source geometry as a child mesh
    // of the pivot group WITHOUT a duplicate semanticId (plan E2). Runtime snapshot
    // attribution walks to the pivot semantic, so the geometry measures as pivot-intrinsic
    // while the pivot remains a transform anchor group.
    const worldPivotPoints: number[] = [];
    const collarIndices: number[] = [];
    for (const localIndex of pivotComponent!.triangleIndices) {
      const offset = localIndex * 9;
      const base = worldPivotPoints.length / 3;
      for (let vertex = 0; vertex < 3; vertex += 1) {
        worldPivotPoints.push(
          snapshot.triangleData.positions[offset + vertex * 3]!,
          snapshot.triangleData.positions[offset + vertex * 3 + 1]!,
          snapshot.triangleData.positions[offset + vertex * 3 + 2]!,
        );
        collarIndices.push(base + vertex);
      }
    }
    nodes.push({
      semanticId: "gun-pivot-intrinsic",
      kind: "mesh",
      parentSemanticId: "gun-pivot",
      attributeToParent: true,
      positions: localPositions(Float32Array.from(worldPivotPoints), pivotOrigin),
      indices: Uint32Array.from(collarIndices),
    });
  }
  return { nodes, inputTriangles: gun.triangleIndices.length };
}

interface PhaseSeed {
  name: string;
  inputGeometryHash: string;
  inputTriangles: number;
  simplify: (ratio: number | undefined, error: number | undefined) => Promise<{ nodes: SeedNode[]; error?: number }>;
}

/**
 * Extracts one connected island into a standalone indexed mesh so it can be simplified
 * INDEPENDENTLY of every other island (Â§12). Islands never share welded vertex indices, so
 * the remap is exact.
 */
function extractIsland(positions: Float32Array, indices: Uint32Array): { positions: Float32Array; indices: Uint32Array } {
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

const MIN_ISLAND_TRIANGLES = 24;

/**
 * Multipart source-preserving simplification (Â§12): each significant connected component is
 * simplified independently under a deterministic per-component budget derived from its
 * surface-area share (square-root weighted, with a minimum floor), so one dominant shell
 * can never erase smaller silhouette-defining islands. Borders stay locked; the source
 * tier keeps everything untouched.
 */
async function simplifyComponentwise(mesh: CleanedMesh, ratio: number | undefined, error: number | undefined, keepAllIslands = false): Promise<{ positions: Float32Array; indices: Uint32Array; error?: number }> {
  if (ratio === undefined || mesh.components.length <= 1) return simplifyMesh(mesh.positions, mesh.indices, ratio, error);
  const totalArea = mesh.components.reduce((sum, component) => sum + component.area, 0) || 1e-9;
  const maxDiagonal = Math.max(...mesh.components.map((component) => Math.hypot(component.bounds.size[0], component.bounds.size[1], component.bounds.size[2])), 1e-9);
  // Significance mirrors the seed-pruning thresholds; insignificant islands were already
  // pruned before this point for the seed route. A component-keep semantic keeps ALL of its
  // islands in the simplification input (plan E1: keep means "do not prune", for
  // significant AND insignificant islands alike).
  const significant = keepAllIslands
    ? mesh.components
    : mesh.components.filter((component) => {
      const diagonal = Math.hypot(component.bounds.size[0], component.bounds.size[1], component.bounds.size[2]);
      return component.area >= totalArea * 0.005 || diagonal >= maxDiagonal * 0.05;
    });
  const weights = significant.map((component) => Math.sqrt(Math.max(component.area, 1e-9)));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0) || 1e-9;
  const totalTargetIndices = mesh.indices.length * ratio;
  const outPositions: number[] = [];
  const outIndices: number[] = [];
  let simplifierError: number | undefined;
  for (const [slot, component] of significant.entries()) {
    const island = extractIsland(mesh.positions, component.indices);
    const share = weights[slot]! / weightSum;
    const proportional = Math.floor((totalTargetIndices * share) / 3) * 3;
    const islandRatio = island.indices.length > MIN_ISLAND_TRIANGLES
      ? Math.min(1, Math.max(proportional, MIN_ISLAND_TRIANGLES * 3) / island.indices.length)
      : undefined; // small-but-significant islands keep their full shape
    const simplified = await simplifyMesh(island.positions, island.indices, islandRatio ?? undefined, error);
    if (simplified.error !== undefined) simplifierError = Math.max(simplifierError ?? 0, simplified.error);
    const baseVertex = outPositions.length / 3;
    for (let index = 0; index < simplified.positions.length; index += 1) outPositions.push(simplified.positions[index]!);
    for (let index = 0; index < simplified.indices.length; index += 1) outIndices.push(baseVertex + simplified.indices[index]!);
  }
  return { positions: Float32Array.from(outPositions), indices: Uint32Array.from(outIndices), ...(simplifierError !== undefined ? { error: simplifierError } : {}) };
}

async function buildMeshSimplifySeed(snapshot: SceneSnapshot, profile: ProfileId, phase: string, simplifyOverrides: ReadonlyMap<string, { ratio?: number; error?: number }> = new Map(), keepTargets: ReadonlySet<string> = new Set()): Promise<PhaseSeed> {
  const route = phaseOperator(profile, phase)!;
  const soups = collectSemantics(snapshot, route.semantics);
  if (!soups.size) throw new Error(`prepared oracle carries no ${route.label} geometry to derive from`);
  // component-keep applicability (pipeline remediation plan E1): a marker that can never
  // affect the selected seed fails clearly instead of silently succeeding. The target must
  // be a semantic owned by this phase's route that intrinsically owns oracle geometry.
  for (const target of keepTargets) {
    const component = snapshot.components[target];
    if (!component || !component.triangleIndices.length || !route.semantics(target, component.role) || !soups.has(target)) {
      throw new Error(`component-keep target "${target}" is not a semantic owned by phase ${phase} with intrinsic oracle geometry; nothing to keep`);
    }
  }
  const inputTriangles = [...soups.values()].reduce((sum, soup) => sum + soup.triangleCount, 0);
  const overallSize = measureBounds(snapshot).size.filter((value) => value > 0);
  const epsilon = Math.max(Math.max(...overallSize, 1e-9) * 2e-5, 1e-6);
  const cleanedPerSemantic = new Map<string, CleanedMesh>();
  for (const [id, soup] of soups) {
    // Keep means "do not prune": kept semantics skip insignificant-island pruning entirely.
    cleanedPerSemantic.set(id, keepTargets.has(id) ? cleanAndSplit(soup, epsilon) : pruneInsignificant(cleanAndSplit(soup, epsilon)));
  }
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
        const override = simplifyOverrides.get(id);
        const result = await simplifyComponentwise(cleaned, override?.ratio ?? ratio, override?.error ?? error, keepTargets.has(id));
        if (result.error !== undefined) simplifierError = Math.max(simplifierError ?? 0, result.error);
        const parentSemanticId = pivotOrigin && id !== "turret-pivot" ? "turret-pivot" : undefined;
        const positions = parentSemanticId ? localPositions(result.positions, pivotOrigin!) : result.positions;
        nodes.push({ semanticId: id, kind: "mesh", ...(parentSemanticId ? { parentSemanticId } : {}), positions, indices: result.indices });
      }
      return { nodes, ...(simplifierError !== undefined ? { error: simplifierError } : {}) };
    },
  };
}

/**
 * Evaluates one trial derived composition through the trusted sandbox path (Â§9): the trial
 * registry/seeds/repairs are staged into isolated scratch and executed exactly like an
 * ordinary candidate â€” tier selection can never use an easier bypass than normal gates.
 */
async function evaluateTrialComposition(
  workspace: ResumedWorkspace,
  phase: string,
  oracle: THREE.Object3D,
  authoritativeDimensions: Record<string, number> | undefined,
  auditOptions: { trustedGeneratedModules: Map<string, unknown> },
  backend: import("./candidate-sandbox.js").SandboxBackend | undefined,
  executionScratchRoot?: string,
): Promise<{
  passed: boolean;
  score: number;
  triangles: number;
  meshes: number;
  failingGates: Array<{ code: string; score: number; message: string }>;
  diagnostic: TierDiagnostic;
}> {
  const { executeComposedDerivedTrial, deserializeExecutionSamples } = await import("./composition-exec.js");
  const { evaluateCandidateFromSamples } = await import("./orchestration.js");
  const subjectContract = workspace.resolved.subjectContract
    ? JSON.parse(await readFile(workspace.resolved.subjectContract, "utf8")) as GenericSubjectContract
    : undefined;
  const profileContract = getProfileContract(workspace.project.profile);
  const phaseOwnsArticulation = profileContract.gates.some((gate) => gate.code === "articulation.poses" && gate.phase === phase);
  const poses = phaseOwnsArticulation ? requiredPosesForProfile(workspace.project.profile, subjectContract) : [neutralPoseForProfile(workspace.project.profile, subjectContract)];
  const scratchRoot = join(workspace.layout.internal.root, "tmp");
  await mkdir(scratchRoot, { recursive: true });
  const trial = await executeComposedDerivedTrial({
    workspaceRoot: workspace.root,
    scratchRoot,
    profile: workspace.project.profile,
    poses,
    auditOptions,
    ...(backend ? { backend } : {}),
    ...(executionScratchRoot ? { executionScratchRoot } : {}),
  });
  try {
    if (!trial.result.audit.passed) throw new Error(`trial composition audit failed: ${trial.result.audit.findings.map((finding) => finding.code).join(", ")}`);
    const samples = deserializeExecutionSamples(trial.result);
    const evaluation = await evaluateCandidateFromSamples({
      oracle,
      candidateSamples: [
        { pose: poses[0]!, root: samples.neutralRoot },
        ...samples.posedRoots.map((sample) => ({ pose: sample.pose, root: sample.root })),
      ],
      profile: workspace.project.profile,
      style: workspace.styleContract,
      certification: workspace.state.certification,
      candidateSourceHash: trial.result.sourceHash,
      ...(authoritativeDimensions ? { authoritativeDimensions: authoritativeDimensions as { hullLength: number; overallLength: number; width: number; height: number } } : {}),
      ...(subjectContract ? { subjectContract } : {}),
      phase,
    });
    void evaluation.candidateHash;
    const phaseReport = evaluation.phaseGates[phase];
    // Early complexity admissibility over the COMPOSED totals: geometrically acceptable is
    // not yet lockable when the workspace hard style ceiling is already exceeded.
    const composedSnapshot = snapshotScene(samples.neutralRoot);
    const phaseRows = phaseReport?.rows ?? evaluation.contractGates.rows;
    const fidelityScores = phaseRows.map((row) => row.score).filter((value) => value > 0);
    const diagnostic: TierDiagnostic = {
      passedGateCount: phaseRows.filter((row) => row.passed).length,
      gateCount: phaseRows.length,
      meanGateScore: phaseRows.length ? phaseRows.reduce((sum, row) => sum + row.score, 0) / phaseRows.length : 0,
      minFidelityGateScore: fidelityScores.length ? Math.min(...fidelityScores) : phaseRows.length,
    };
    return {
      passed: evaluation.passed && Boolean(phaseReport?.passed),
      score: phaseReport?.score ?? evaluation.contractGates.score,
      triangles: composedSnapshot.triangleCount,
      meshes: composedSnapshot.meshCount,
      diagnostic,
      failingGates: [
        ...evaluation.deterministic.rows.filter((row) => !row.passed).map((row) => ({ code: row.code, score: row.score, message: row.message })),
        ...Object.values(evaluation.phaseGates).flatMap((report) => report.rows.filter((row) => !row.passed).map((row) => ({ code: row.code, score: row.score, message: row.message }))),
      ],
    };
  } finally {
    await trial.cleanup();
  }
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

/**
 * Reconciles pipeline-owned derived workspace artifacts from CANONICAL state bindings
 * (pipeline remediation plan C4/D4). Responsibilities:
 * - regenerate `model/.generated/registry.mjs` from canonical generated bindings;
 * - remove generated modules and derivation manifests for phases no longer bound;
 * - never modify `model/repairs/*.json` (user-authored repair input survives, D5);
 * - be safe to run repeatedly: bytes are written only when they actually differ.
 *
 * Canonical run authority stays the single source of truth: this helper never invents phase
 * presence from manifest sidecars, and a reconciliation failure surfaces a specific error
 * while the next trusted operation can simply rerun it from canonical state.
 */
export async function reconcileDerivedWorkspaceFromBindings(workspace: ResumedWorkspace, state: TaskState): Promise<void> {
  if (state.authorshipMode !== "derived") return;
  const ordered = orderedDerivedPhasesFromBindings(workspace.project.profile, state.derivedBindings ?? {});
  const boundPhases = new Set(ordered);
  const generatedDirectory = resolve(workspace.root, GENERATED_DIRECTORY);
  // Generated modules for phases no longer bound are pruned; registry.mjs is regenerated below.
  let moduleNames: string[] = [];
  try {
    moduleNames = await readdir(generatedDirectory);
  } catch { /* directory absent: nothing to prune */ }
  for (const name of moduleNames.sort()) {
    if (!name.endsWith(".mjs") || name === "registry.mjs") continue;
    if (boundPhases.has(name.slice(0, -".mjs".length))) continue;
    try {
      await rm(join(generatedDirectory, name));
    } catch (error) {
      throw new Error(`derived workspace reconciliation could not prune unbound generated module ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Derivation manifests for unbound phases are provenance sidecars only; prune them too.
  const manifestDirectory = derivedDirectory(workspace.layout.internal.root);
  let manifestNames: string[] = [];
  try {
    manifestNames = await readdir(manifestDirectory);
  } catch { /* directory absent: nothing to prune */ }
  for (const name of manifestNames.sort()) {
    if (!name.endsWith(".json")) continue;
    if (boundPhases.has(name.slice(0, -".json".length))) continue;
    try {
      await rm(join(manifestDirectory, name));
    } catch (error) {
      throw new Error(`derived workspace reconciliation could not prune unbound derivation manifest ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const expectedRegistry = generateRegistrySource(workspace.project.profile, ordered);
  await mkdir(generatedDirectory, { recursive: true });
  const registryPath = resolve(workspace.root, GENERATED_REGISTRY_PATH);
  let current: string | null = null;
  try {
    current = await readFile(registryPath, "utf8");
  } catch { /* missing registry is regenerated */ }
  if (current !== expectedRegistry) await writeFile(registryPath, expectedRegistry);
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

/**
 * Pure tier-selection policy: geometrically acceptable is distinct from LOCKABLE. A tier that
 * cleared active gates but violates the hard style ceiling is diagnostic repair input only.
 *
 * Passing tiers: first/simplest eligible passing tier wins (unchanged). Failing tiers: rank by
 * diagnostic usefulness — most required gates passed, then best mean required-gate score, then
 * best worst-fidelity score, then lower complexity — so a shared binary zero row (e.g. one
 * connectivity gate) cannot make every failing tier indistinguishable and retain an
 * uninformative aggressive tier over a high-fidelity source-preserve tier.
 */
export function resolveSeedOutcome(tierResults: ReadonlyArray<DeriveTierResult>): { status: DeriveStatus; reasonCode?: DeriveReasonCode; chosen?: DeriveTierResult } {
  const eligiblePassing = tierResults.find((tier) => tier.passed && tier.withinComplexityBudget !== false);
  const overBudgetPassing = tierResults.filter((tier) => tier.passed && tier.withinComplexityBudget === false);
  if (eligiblePassing) return { status: "seed-passing", chosen: eligiblePassing };
  if (overBudgetPassing.length) {
    return { status: "seed-diagnostic-overbudget", reasonCode: "derive.over-budget-fallback", chosen: overBudgetPassing.reduce((best, tier) => (tier.score > best.score ? tier : best)) };
  }
  const failing = tierResults.slice();
  const best = failing.reduce<DeriveTierResult | undefined>((acc, tier) => {
    if (!acc) return tier;
    return compareFailingTiers(tier, acc) < 0 ? tier : acc;
  }, undefined);
  return { status: "seed-retained-failing", reasonCode: "derive.no-passing-tier", ...(best ? { chosen: best } : {}) };
}

/** Diagnostic usefulness order for failing tiers; negative means `a` ranks before `b`. */
export function compareFailingTiers(a: DeriveTierResult, b: DeriveTierResult): number {
  const da = a.diagnostic, db = b.diagnostic;
  if (da && db) {
    if (da.passedGateCount !== db.passedGateCount) return db.passedGateCount - da.passedGateCount;
    if (Math.abs(da.meanGateScore - db.meanGateScore) > 1e-9) return db.meanGateScore - da.meanGateScore;
    if (da.minFidelityGateScore !== db.minFidelityGateScore) return db.minFidelityGateScore - da.minFidelityGateScore;
  }
  if (a.score !== b.score) return b.score - a.score;
  return a.triangles - b.triangles;
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
  // Trusted derived mode executes NO builder-authored executable code (closure plan §6.C4).
  await assertNoExecutableRepairs(workspace.root);
  const phase = state.activePhase;
  const route = phaseOperator(workspace.project.profile, phase);
  if (!route) {
    return { status: "not-supported", phase, operator: "none", tiers: [], note: `derive supports hull, turret, gun, running-gear, and tracks; active phase is ${phase}` };
  }
  const preparation = await verifyWorkspaceOraclePreparation(workspace);
  const oracle = await loadPreparedOracle(preparation.manifest, workspace.root);
  // Source assembly coverage must be complete BEFORE derivation (Â§11): unresolved
  // significant geometry blocks the derive instead of silently disappearing.
  if (workspace.project.profile === "tank") assertAssemblyCoverage(oracle, "tank");
  const snapshot = snapshotScene(oracle);
  const authoritativeDimensions = preparation.manifest.authoritativeDimensions ?? undefined;

  // Trial-local binding ledger: updated per tier so trial audits see the CURRENT five-way
  // authority without persisting anything until a tier is finally selected.
  const localBindings: Record<string, import("./state.js").DerivedBinding> = { ...(state.derivedBindings ?? {}) };
  for (const repair of await discoverRepairs(workspace.root)) {
    try {
      const bytes = await readFile(resolve(workspace.root, repair.path));
      localBindings[repair.path.replaceAll("\\", "/")] = repairBinding(repair, sha256(bytes), preparation.binding.identity);
    } catch { /* missing repair file surfaces through lineage verification */ }
  }
  // The active phase's declarative repair spec (agent-owned DATA) is validated mechanically
  // and compiled into generated module bytes by trusted derive (closure plan §6.C1/C3).
  let phaseRepairSpec: DerivedRepairSpec | undefined;
  let repairSpecRawHash: string | undefined;
  try {
    const specBytes = await readFile(resolve(workspace.root, REPAIRS_DIRECTORY, `${phase}.json`), "utf8");
    repairSpecRawHash = sha256(Buffer.from(specBytes, "utf8"));
    phaseRepairSpec = validateRepairSpec(JSON.parse(specBytes), phase);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const simplifyOverrides = new Map<string, { ratio?: number; error?: number }>();
  const keepTargets = new Set<string>();
  if (phaseRepairSpec) {
    for (const operation of phaseRepairSpec.operations) {
      if (operation.op === "simplify-override") simplifyOverrides.set(operation.target, { ...(operation.ratio !== undefined ? { ratio: operation.ratio } : {}), ...(operation.error !== undefined ? { error: operation.error } : {}) });
      if (operation.op === "component-keep") keepTargets.add(operation.target);
    }
  }
  // Analytic primitive-regeneration routes have no prunable source islands; a keep marker
  // can never affect them and must fail clearly rather than silently succeed (plan E1).
  if (route.operator === "radial-fit" || route.operator === "course-regenerate") {
    for (const target of keepTargets) {
      throw new Error(`component-keep target "${target}" cannot affect the ${route.operator} ${route.label} seed: the route regenerates primitives and has no prunable source islands`);
    }
  }
  const trialAuditOptions = async (): Promise<{ trustedGeneratedModules: Map<string, unknown> }> => ({
    trustedGeneratedModules: await loadTrustedGeneratedModules({
      directory: derivedDirectory(workspace.layout.internal.root),
      workspaceRoot: workspace.root,
      preparationIdentity: preparation.binding.identity,
      bindings: localBindings,
      allowedPhases: new Set(getProfileContract(workspace.project.profile).phases.filter((item) => item.owner === "builder").map((item) => item.id)),
    }),
  });

  let seed: PhaseSeed;
  const analytic = route.operator !== "mesh-simplify";
  if (route.operator === "mesh-simplify") {
    seed = await buildMeshSimplifySeed(snapshot, workspace.project.profile, phase, simplifyOverrides, keepTargets);
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
    const built = buildGunSeed(snapshot, keepTargets);
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
    const simplified = await seed.simplify(tier.ratio, tier.error);
    // Declarative repairs are compiled in by trusted code BEFORE any evaluation or byte
    // emission, so repair effects participate in trial gates and module hashes alike.
    const built = { ...simplified, nodes: phaseRepairSpec ? applyRepairSpec(simplified.nodes, phaseRepairSpec) : simplified.nodes };
    const outputTriangles = built.nodes.reduce((sum, node) => sum + (node.indices?.length ?? 0) / 3, 0);
    if (!outputTriangles) continue;
    // Materialize THIS tier as the pipeline-owned composition (seed module + registry), then
    // execute the staged composition through the trusted sandbox exactly like a candidate.
    const moduleSource = emitGeneratedModule(seed.name, built.nodes);
    const generatedModuleHash = sha256(Buffer.from(moduleSource, "utf8"));
    await mkdir(resolve(workspace.root, GENERATED_DIRECTORY), { recursive: true });
    await writeFile(resolve(workspace.root, GENERATED_DIRECTORY, `${seed.name}.mjs`), moduleSource);
    localBindings[`${GENERATED_DIRECTORY}/${seed.name}.mjs`] = {
      manifestHash: sha256(canonicalJson({ pending: true, phase, hash: generatedModuleHash })),
      generatedModuleHash,
      oraclePreparationIdentity: preparation.binding.identity,
    };
    // The manifest on disk must match the binding for five-way authority; write it now.
    const inputGeometryHashPlaceholder = seed.inputGeometryHash;
    const trialManifestSeed: DerivationManifest = {
      schemaVersion: 1,
      kind: "mesh2threejs-derived-seed",
      phase,
      oraclePreparationIdentity: preparation.binding.identity,
      preparedOracleHash: preparation.binding.preparedHash,
      operator: route.operator,
      recipe: { tier: tier.tier },
      inputGeometryHash: inputGeometryHashPlaceholder,
      outputGeometryHash: sha256(canonicalJson(built.nodes.filter((node) => node.kind === "mesh").map((node) => ({ id: node.semanticId, geometryHash: geometryBytesHash(node.positions!, node.indices!) })))),
      generatedModulePath: `${GENERATED_DIRECTORY}/${seed.name}.mjs`,
      generatedModuleHash,
      inputTriangles: seed.inputTriangles,
      outputTriangles: Math.round(outputTriangles),
      ...(repairSpecRawHash !== undefined ? { repairSpecHash: repairSpecRawHash, repairOperations: phaseRepairSpec?.operations.length ?? 0 } : {}),
    };
    const manifestDirectory = derivedDirectory(workspace.layout.internal.root);
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(join(manifestDirectory, `${phase}.json`), `${JSON.stringify(trialManifestSeed, null, 2)}\n`);
    const trialBinding = localBindings[`${GENERATED_DIRECTORY}/${seed.name}.mjs`];
    if (!trialBinding) throw new Error("derive lost its trial binding ledger entry");
    trialBinding.manifestHash = derivationManifestHash(trialManifestSeed);
    // Trial composition comes from the PROVISIONAL local binding ledger (plan C3): manifest
    // sidecars on disk are provenance, never phase presence. The ledger already carries the
    // trial binding for the active phase plus every still-valid earlier phase.
    await wireGeneratedComposition(workspace, orderedDerivedPhasesFromBindings(workspace.project.profile, localBindings));
    let verdict: Awaited<ReturnType<typeof evaluateTrialComposition>>;
    try {
      verdict = await evaluateTrialComposition(workspace, phase, oracle, authoritativeDimensions, await trialAuditOptions(), options.backend, options.executionScratchRoot);
    } catch (error) {
      // A trial that cannot even execute (e.g. audit failure) is a failing tier, not a crash:
      // the derive ladder must remain bounded and informative.
      verdict = { passed: false, score: 0, triangles: Math.round(outputTriangles), meshes: built.nodes.filter((node) => node.kind === "mesh").length, failingGates: [{ code: "derive.trial-execution", score: 0, message: error instanceof Error ? error.message : String(error) }], diagnostic: { passedGateCount: 0, gateCount: 0, meanGateScore: 0, minFidelityGateScore: 0 } };
    }
    evaluatedNodes.set(tier.tier, built.nodes);
    const withinBudget = verdict.triangles <= triangleMax && verdict.meshes <= meshMax;
    tierResults.push({
      tier: tier.tier,
      triangles: Math.round(outputTriangles),
      passed: verdict.passed,
      score: verdict.score,
      failingGates: verdict.failingGates,
      diagnostic: verdict.diagnostic,
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
    ...(repairSpecRawHash !== undefined ? { repairSpecHash: repairSpecRawHash, repairOperations: phaseRepairSpec?.operations.length ?? 0 } : {}),
  };

  let workorders: Workorder[] | undefined;
  if (status !== "seed-passing") {
    try {
      workorders = (tierResults.find((tier) => tier.tier === chosen.tier)?.failingGates ?? []).map((gate) => ({
        component: gate.code,
        errorKind: gate.code,
        priority: "critical" as const,
        correction: gate.message,
        phase,
      }));
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

  /** Applies the derive's durable binding/state mutations to one base TaskState. */
  const applyDeriveMutations = (base: TaskState): TaskState => {
    const next = { ...base, derivedBindings: { ...base.derivedBindings } };
    next.derivedBindings[manifest.generatedModulePath] = {
      manifestHash: derivationManifestHash(manifest),
      generatedModuleHash: manifest.generatedModuleHash,
      oraclePreparationIdentity: manifest.oraclePreparationIdentity,
    };
    for (const repair of repairEntries) {
      next.derivedBindings[repair.key] = {
        manifestHash: sha256(canonicalJson({ kind: "repair-binding", phase: repair.phase })),
        generatedModuleHash: repair.specHash,
        oraclePreparationIdentity: preparation.binding.identity,
      };
    }
    next.systemDecisions.push({
      id: `derived-seed-${next.systemDecisions.length + 1}`,
      value: manifest.generatedModulePath,
      reason: `derive produced a ${chosen.tier} ${route.operator} seed for phase ${phase} (${seed.inputTriangles} -> ${chosen.triangles} triangles, status ${status})`,
    });
    return next;
  };
  const repairEntries = (await discoverRepairs(workspace.root)).map((repair) => ({
    key: repair.path.replaceAll("\\", "/"),
    phase: repair.phase,
    specHash: sha256(readFileSync(resolve(workspace.root, repair.path))),
  }));
  const mutated = applyDeriveMutations(state);
  // After a derive is chosen, the registry regenerates from the resulting CANONICAL binding
  // ledger (plan C3). Stale derivation manifests left on disk by earlier phases or failed
  // trials cannot re-enter composition by being present.
  const wiring = await wireGeneratedComposition(workspace, orderedDerivedPhasesFromBindings(workspace.project.profile, mutated.derivedBindings));

  const nextState = options.persistState
    ? await options.persistState(applyDeriveMutations(state))
    : await (async () => {
        const mutated = applyDeriveMutations(await loadTaskState(workspace.layout.internal.state));
        await saveTaskState(workspace.layout.internal.state, mutated);
        return mutated;
      })();
  // Derived lineage preconditions (§10.6): canonical entry, pipeline registry, five-way
  // generated authority, and repair bindings must all verify BEFORE any fidelity gate runs.
  await verifyDerivedLineage({
    modelEntryPath: resolve(workspace.root, workspace.project.model),
    workspaceRoot: workspace.root,
    profile: workspace.project.profile,
    authorshipMode: "derived",
    derivedBindings: nextState.derivedBindings,
    trustedModules: await loadTrustedGeneratedModules({
      directory: derivedDirectory(workspace.layout.internal.root),
      workspaceRoot: workspace.root,
      preparationIdentity: preparation.binding.identity,
      bindings: nextState.derivedBindings,
      allowedPhases: new Set(getProfileContract(workspace.project.profile).phases.filter((item) => item.owner === "builder").map((item) => item.id)),
    }),
  });

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

import * as THREE from "three";
import { canonicalJson, sha256 } from "./hashing.js";
import type { SeedNode } from "./derive.js";

/**
 * Declarative derived-repair specifications (closure plan §6.C1/C2). Agent-owned repairs
 * are DATA, never executable modules: trusted derive validates this structure mechanically
 * and compiles it into pipeline-generated phase-module bytes itself. There are no JS
 * expressions, imports, callbacks, paths, URLs, code strings, or runtime state reads.
 */

export interface DerivedRepairSpec {
  schemaVersion: 1;
  /** The builder phase this repair belongs to; validated against the active repair owner. */
  phase: string;
  operations: RepairOperation[];
}

export type Vec3 = readonly [number, number, number];

export type RepairPrimitive =
  | { kind: "box"; size: Vec3 }
  | { kind: "cylinder"; radius: number; height: number; segments: number; axis?: "x" | "y" | "z" }
  | { kind: "tube"; from: Vec3; to: Vec3; radius: number; segments: number };

export type RepairOperation =
  | { op: "component-transform"; target: string; translate?: Vec3; rotateDegrees?: Vec3; scale?: Vec3 }
  | { op: "simplify-override"; target: string; ratio?: number; error?: number }
  | { op: "component-keep"; target: string }
  | { op: "component-drop"; target: string }
  | { op: "hierarchy-parent"; target: string; parent: string | null }
  | { op: "primitive-replace"; target: string; primitive: RepairPrimitive }
  | { op: "mesh-replace"; target: string; positions: number[]; indices: number[] }
  | { op: "material"; target: string; color?: Vec3; roughness?: number; metalness?: number; flatShading?: boolean };

/** Per-repair complexity ceiling (closure plan §6.C2): oversized payloads fail BEFORE execution. */
export const REPAIR_VERTEX_CEILING = 5000;
export const REPAIR_TRIANGLE_CEILING = 10_000;

const OPERATIONS = new Set(["component-transform", "simplify-override", "component-keep", "component-drop", "hierarchy-parent", "primitive-replace", "mesh-replace", "material"]);

class RepairValidationError extends Error {}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RepairValidationError(`${label} must be a finite number`);
  return value;
}

function finiteVec3(value: unknown, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new RepairValidationError(`${label} must be [x,y,z]`);
  return [finiteNumber(value[0], `${label}[0]`), finiteNumber(value[1], `${label}[1]`), finiteNumber(value[2], `${label}[2]`)];
}

function optionalVec3(op: Record<string, unknown>, key: string, label: string): Vec3 | undefined {
  return key in op ? finiteVec3(op[key], label) : undefined;
}

function assertOnlyKeys(object: Record<string, unknown>, allowed: ReadonlyArray<string>, label: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new RepairValidationError(`${label} carries unknown key "${key}"`);
  }
}

/**
 * Mechanically validates one repair specification (closure plan §6.C2). Structural JSON
 * parsing already excludes code/imports/expressions; this adds exact-key checks, finite
 * numeric checks, index-range checks, and complexity ceilings. Semantic existence, phase
 * ownership, and parent legality are checked at compile time against live seed nodes.
 */
export function validateRepairSpec(input: unknown, expectedPhase: string): DerivedRepairSpec {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RepairValidationError("repair spec must be an object");
  const spec = input as Record<string, unknown>;
  assertOnlyKeys(spec, ["schemaVersion", "phase", "operations"], "repair spec");
  if (spec.schemaVersion !== 1) throw new RepairValidationError("repair spec schemaVersion must be 1");
  if (typeof spec.phase !== "string" || !spec.phase.trim()) throw new RepairValidationError("repair spec phase must be a non-empty string");
  if (spec.phase !== expectedPhase) throw new RepairValidationError(`repair spec targets phase ${spec.phase}, but the current repair owner is ${expectedPhase}`);
  if (!Array.isArray(spec.operations)) throw new RepairValidationError("repair spec operations must be an array");
  const operations: RepairOperation[] = [];
  for (const raw of spec.operations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RepairValidationError("repair operation must be an object");
    const record = raw as Record<string, unknown>;
    if (typeof record.op !== "string" || !OPERATIONS.has(record.op)) throw new RepairValidationError(`unknown repair operation: ${String(record.op)}`);
    if (typeof record.target !== "string" || !record.target.trim()) throw new RepairValidationError("repair operation target must be a non-empty string");
    switch (record.op) {
      case "component-transform": {
        assertOnlyKeys(record, ["op", "target", "translate", "rotateDegrees", "scale"], String(record.op));
        operations.push({
          op: "component-transform",
          target: record.target,
          ...(optionalVec3(record, "translate", "translate") ? { translate: optionalVec3(record, "translate", "translate")! } : {}),
          ...(optionalVec3(record, "rotateDegrees", "rotateDegrees") ? { rotateDegrees: optionalVec3(record, "rotateDegrees", "rotateDegrees")! } : {}),
          ...(optionalVec3(record, "scale", "scale") ? { scale: optionalVec3(record, "scale", "scale")! } : {}),
        });
        break;
      }
      case "simplify-override": {
        assertOnlyKeys(record, ["op", "target", "ratio", "error"], String(record.op));
        const operation: Extract<RepairOperation, { op: "simplify-override" }> = { op: "simplify-override", target: record.target };
        if ("ratio" in record) {
          const ratio = finiteNumber(record.ratio, "ratio");
          if (ratio <= 0 || ratio > 1) throw new RepairValidationError("simplify ratio must lie in (0, 1]");
          operation.ratio = ratio;
        }
        if ("error" in record) {
          const error = finiteNumber(record.error, "error");
          if (error < 0 || error >= 1) throw new RepairValidationError("simplify error must lie in [0, 1)");
          operation.error = error;
        }
        operations.push(operation);
        break;
      }
      case "component-keep":
      case "component-drop": {
        assertOnlyKeys(record, ["op", "target"], String(record.op));
        operations.push({ op: record.op, target: record.target });
        break;
      }
      case "hierarchy-parent": {
        assertOnlyKeys(record, ["op", "target", "parent"], String(record.op));
        if (record.parent !== null && (typeof record.parent !== "string" || !record.parent.trim())) throw new RepairValidationError("hierarchy-parent parent must be a non-empty string or null");
        operations.push({ op: "hierarchy-parent", target: record.target, parent: record.parent as string | null });
        break;
      }
      case "primitive-replace": {
        assertOnlyKeys(record, ["op", "target", "primitive"], String(record.op));
        operations.push({ op: "primitive-replace", target: record.target, primitive: validatePrimitive(record.primitive) });
        break;
      }
      case "mesh-replace": {
        assertOnlyKeys(record, ["op", "target", "positions", "indices"], String(record.op));
        if (!Array.isArray(record.positions) || !Array.isArray(record.indices)) throw new RepairValidationError("mesh-replace positions and indices must be arrays");
        const positions = record.positions.map((value, index) => finiteNumber(value, `positions[${index}]`));
        const indices = record.indices.map((value, index) => {
          const indexValue = finiteNumber(value, `indices[${index}]`);
          if (!Number.isInteger(indexValue) || indexValue < 0 || indexValue >= positions.length / 3) throw new RepairValidationError(`index ${indexValue} is outside the vertex range`);
          return indexValue;
        });
        if (positions.length === 0 || positions.length % 3 !== 0) throw new RepairValidationError("mesh-replace positions must be a non-empty multiple of 3");
        if (indices.length === 0 || indices.length % 3 !== 0) throw new RepairValidationError("mesh-replace indices must be a non-empty multiple of 3");
        if (positions.length / 3 > REPAIR_VERTEX_CEILING) throw new RepairValidationError(`mesh-replace exceeds the ${REPAIR_VERTEX_CEILING} vertex ceiling`);
        if (indices.length / 3 > REPAIR_TRIANGLE_CEILING) throw new RepairValidationError(`mesh-replace exceeds the ${REPAIR_TRIANGLE_CEILING} triangle ceiling`);
        operations.push({ op: "mesh-replace", target: record.target, positions, indices });
        break;
      }
      case "material": {
        assertOnlyKeys(record, ["op", "target", "color", "roughness", "metalness", "flatShading"], String(record.op));
        const operation: Extract<RepairOperation, { op: "material" }> = { op: "material", target: record.target };
        if ("color" in record) operation.color = finiteVec3(record.color, "color");
        if ("roughness" in record) {
          const roughness = finiteNumber(record.roughness, "roughness");
          if (roughness < 0 || roughness > 1) throw new RepairValidationError("roughness must lie in [0, 1]");
          operation.roughness = roughness;
        }
        if ("metalness" in record) {
          const metalness = finiteNumber(record.metalness, "metalness");
          if (metalness < 0 || metalness > 1) throw new RepairValidationError("metalness must lie in [0, 1]");
          operation.metalness = metalness;
        }
        if ("flatShading" in record) {
          if (typeof record.flatShading !== "boolean") throw new RepairValidationError("flatShading must be boolean");
          operation.flatShading = record.flatShading;
        }
        operations.push(operation);
        break;
      }
      default: {
        throw new RepairValidationError(`unknown repair operation: ${String(record.op)}`);
      }
    }
  }
  return { schemaVersion: 1, phase: spec.phase, operations };
}

function validatePrimitive(value: unknown): RepairPrimitive {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RepairValidationError("primitive must be an object");
  const primitive = value as Record<string, unknown>;
  if (primitive.kind === "box") {
    assertOnlyKeys(primitive, ["kind", "size"], "box");
    return { kind: "box", size: finiteVec3(primitive.size, "box.size") };
  }
  if (primitive.kind === "cylinder") {
    assertOnlyKeys(primitive, ["kind", "radius", "height", "segments", "axis"], "cylinder");
    if (primitive.axis !== undefined && primitive.axis !== "x" && primitive.axis !== "y" && primitive.axis !== "z") throw new RepairValidationError("cylinder axis must be x, y, or z");
    const segments = finiteNumber(primitive.segments, "cylinder.segments");
    if (!Number.isInteger(segments) || segments < 3 || segments > 64) throw new RepairValidationError("cylinder segments must be an integer in [3, 64]");
    const radius = finiteNumber(primitive.radius, "cylinder.radius");
    if (radius <= 0) throw new RepairValidationError("cylinder radius must be positive");
    const height = finiteNumber(primitive.height, "cylinder.height");
    if (height <= 0) throw new RepairValidationError("cylinder height must be positive");
    return {
      kind: "cylinder",
      radius,
      height,
      segments,
      ...(primitive.axis !== undefined ? { axis: primitive.axis } : {}),
    };
  }
  if (primitive.kind === "tube") {
    assertOnlyKeys(primitive, ["kind", "from", "to", "radius", "segments"], "tube");
    const segments = finiteNumber(primitive.segments, "tube.segments");
    if (!Number.isInteger(segments) || segments < 3 || segments > 64) throw new RepairValidationError("tube segments must be an integer in [3, 64]");
    const radius = finiteNumber(primitive.radius, "tube.radius");
    if (radius <= 0) throw new RepairValidationError("tube radius must be positive");
    return { kind: "tube", from: finiteVec3(primitive.from, "tube.from"), to: finiteVec3(primitive.to, "tube.to"), radius, segments };
  }
  throw new RepairValidationError(`unknown primitive kind: ${String(primitive.kind)}`);
}

export function repairSpecHash(spec: DerivedRepairSpec): string {
  return sha256(canonicalJson(spec));
}

function buildPrimitiveGeometry(primitive: RepairPrimitive): { positions: Float32Array; indices: Uint32Array } {
  let geometry: THREE.BufferGeometry;
  if (primitive.kind === "box") {
    geometry = new THREE.BoxGeometry(...primitive.size);
  } else if (primitive.kind === "cylinder") {
    geometry = new THREE.CylinderGeometry(primitive.radius, primitive.radius, primitive.height, primitive.segments, 1, false);
    if (primitive.axis === "x") geometry.rotateZ(Math.PI / 2);
    else if (primitive.axis === "z") geometry.rotateX(Math.PI / 2);
  } else {
    const from = new THREE.Vector3(...primitive.from);
    const to = new THREE.Vector3(...primitive.to);
    const direction = to.clone().sub(from);
    const length = Math.max(direction.length(), 1e-9);
    geometry = new THREE.CylinderGeometry(primitive.radius, primitive.radius, length, primitive.segments, 1, false);
    geometry.translate(0, length / 2, 0);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
    geometry.translate(from.x, from.y, from.z);
  }
  const indexed = geometry.index ? geometry.toNonIndexed() : geometry;
  const positionAttribute = indexed.getAttribute("position");
  const positions = Float32Array.from(positionAttribute.array as Float32Array);
  const vertexCount = positions.length / 3;
  const indices = new Uint32Array(vertexCount);
  for (let index = 0; index < vertexCount; index += 1) indices[index] = index;
  geometry.dispose();
  indexed.dispose();
  return { positions, indices };
}

/**
 * Deterministically applies a validated repair spec to seed nodes. Semantic targets must
 * already exist or be created by mesh-replace/primitive-replace; parents must be existing
 * group/pivot semantics; future-phase or foreign targets fail closed.
 */
export function applyRepairSpec(nodes: SeedNode[], spec: DerivedRepairSpec): SeedNode[] {
  let working = nodes.map((node) => ({ ...node }));
  const exists = (id: string): boolean => working.some((node) => node.semanticId === id);
  for (const operation of spec.operations) {
    switch (operation.op) {
      case "simplify-override":
      case "component-keep":
        break; // consumed elsewhere (simplification budget) / explicit inclusion marker
      case "component-transform": {
        const node = working.find((entry) => entry.semanticId === operation.target);
        if (!node) throw new Error(`repair target does not exist in phase ${spec.phase}: ${operation.target}`);
        if (node.kind === "group") {
          const translation = operation.translate ?? ([0, 0, 0] as const);
          const scale = operation.scale ?? ([1, 1, 1] as const);
          node.position = [
            (node.position?.[0] ?? 0) * scale[0] + translation[0],
            (node.position?.[1] ?? 0) * scale[1] + translation[1],
            (node.position?.[2] ?? 0) * scale[2] + translation[2],
          ];
          break;
        }
        const positions = Float32Array.from(node.positions!);
        const count = positions.length / 3;
        // Rotate/scale about the component centroid so pivots stay meaningful.
        const center: [number, number, number] = [0, 0, 0];
        for (let index = 0; index < count; index += 1) {
          center[0] += positions[index * 3]! / count;
          center[1] += positions[index * 3 + 1]! / count;
          center[2] += positions[index * 3 + 2]! / count;
        }
        const rotation = (operation.rotateDegrees ?? [0, 0, 0]).map((degrees) => (degrees * Math.PI) / 180);
        const scale = operation.scale ?? [1, 1, 1];
        const euler = new THREE.Euler(rotation[0]!, rotation[1]!, rotation[2]!);
        const quaternion = new THREE.Quaternion().setFromEuler(euler);
        const vector = new THREE.Vector3();
        for (let index = 0; index < count; index += 1) {
          vector.set(
            (positions[index * 3]! - center[0]) * scale[0],
            (positions[index * 3 + 1]! - center[1]) * scale[1],
            (positions[index * 3 + 2]! - center[2]) * scale[2],
          ).applyQuaternion(quaternion);
          positions[index * 3] = Number((vector.x + center[0] + (operation.translate?.[0] ?? 0)).toFixed(5));
          positions[index * 3 + 1] = Number((vector.y + center[1] + (operation.translate?.[1] ?? 0)).toFixed(5));
          positions[index * 3 + 2] = Number((vector.z + center[2] + (operation.translate?.[2] ?? 0)).toFixed(5));
        }
        node.positions = positions;
        break;
      }
      case "component-drop": {
        if (!exists(operation.target)) throw new Error(`repair target does not exist in phase ${spec.phase}: ${operation.target}`);
        working = working.filter((node) => node.semanticId !== operation.target && node.parentSemanticId !== operation.target);
        break;
      }
      case "hierarchy-parent": {
        const node = working.find((entry) => entry.semanticId === operation.target);
        if (!node) throw new Error(`repair target does not exist in phase ${spec.phase}: ${operation.target}`);
        if (operation.parent !== null && !working.some((entry) => entry.semanticId === operation.parent && entry.kind === "group")) {
          throw new Error(`hierarchy-parent target must be an existing group semantic: ${String(operation.parent)}`);
        }
        if (operation.parent === operation.target) throw new Error("hierarchy-parent cannot parent a node onto itself");
        if (operation.parent) {
          // World-preserving rebake: meshes keep their owner-local coordinates relative to
          // the NEW pivot origin; groups shift their stored world position.
          const parentNode = working.find((entry) => entry.semanticId === operation.parent)!;
          const parentOrigin = parentNode.position ?? ([0, 0, 0] as const);
          if (node.positions) {
            const origin = nodeOrigin(working, node.semanticId);
            const local = Float32Array.from(node.positions);
            for (let index = 0; index < local.length; index += 3) {
              local[index] = Number((local[index]! + origin[0] - parentOrigin[0]).toFixed(5));
              local[index + 1] = Number((local[index + 1]! + origin[1] - parentOrigin[1]).toFixed(5));
              local[index + 2] = Number((local[index + 2]! + origin[2] - parentOrigin[2]).toFixed(5));
            }
            node.positions = local;
          } else {
            const own = node.position ?? ([0, 0, 0] as const);
            node.position = [own[0] - parentOrigin[0], own[1] - parentOrigin[1], own[2] - parentOrigin[2]];
          }
        }
        if (operation.parent) {
          node.parentSemanticId = operation.parent;
        } else {
          delete node.parentSemanticId;
        }
        break;
      }
      case "primitive-replace":
      case "mesh-replace": {
        const geometry = operation.op === "mesh-replace"
          ? { positions: Float32Array.from(operation.positions), indices: Uint32Array.from(operation.indices) }
          : buildPrimitiveGeometry(operation.primitive);
        const existingIndex = working.findIndex((entry) => entry.semanticId === operation.target);
        const replacement: SeedNode = {
          semanticId: operation.target,
          kind: "mesh",
          positions: geometry.positions,
          indices: geometry.indices,
        };
        if (existingIndex >= 0) {
          if (working[existingIndex]!.role !== undefined) replacement.role = working[existingIndex]!.role;
          if (working[existingIndex]!.parentSemanticId !== undefined) replacement.parentSemanticId = working[existingIndex]!.parentSemanticId;
          working[existingIndex] = replacement;
        } else {
          working.push(replacement);
        }
        break;
      }
      case "material": {
        const node = working.find((entry) => entry.semanticId === operation.target);
        if (!node || node.kind !== "mesh") throw new Error(`material repair target must be an existing mesh semantic: ${operation.target}`);
        node.material = {
          ...(operation.color ? { color: operation.color } : {}),
          ...(operation.roughness !== undefined ? { roughness: operation.roughness } : {}),
          ...(operation.metalness !== undefined ? { metalness: operation.metalness } : {}),
          ...(operation.flatShading !== undefined ? { flatShading: operation.flatShading } : {}),
        };
        break;
      }
      default: {
        const exhaustive: never = operation;
        throw new Error(`unsupported repair operation: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  if (!working.some((node) => node.kind === "mesh")) throw new Error(`repair left phase ${spec.phase} without any geometry`);
  return working;
}

function nodeOrigin(nodes: SeedNode[], semanticId: string): readonly [number, number, number] {
  const node = nodes.find((entry) => entry.semanticId === semanticId);
  if (!node) return [0, 0, 0];
  if (node.kind === "group") return node.position ?? [0, 0, 0];
  // Mesh centroid in its stored (owner-local) frame.
  const positions = node.positions!;
  const count = positions.length / 3;
  const center: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < count; index += 1) {
    center[0] += positions[index * 3]! / count;
    center[1] += positions[index * 3 + 1]! / count;
    center[2] += positions[index * 3 + 2]! / count;
  }
  return center;
}

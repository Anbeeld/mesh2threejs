import * as THREE from "three";
import type { ProfileId } from "../types.js";
import { phaseOwnedSemantics } from "./phase-compose.js";

/**
 * Source assembly coverage (§11). A significant source mesh beneath a mapped critical
 * assembly must be classified before registration/derivation: owned by a phase, explicitly
 * excluded as insignificant/detail, or UNRESOLVED. Unresolved significant geometry blocks
 * registration and derivation — a mapping that labels only one convenient child of a
 * multipart turret cannot silently drop the rest.
 */

export type AssemblyOwnershipClassification =
  | { kind: "owned"; phase: string }
  | { kind: "insignificant-excluded" }
  | { kind: "unresolved" };

export interface AssemblyCoverageEntry {
  /** Stable object identifier (nearest semantic ancestor id, else the mesh name). */
  objectId: string;
  meshName: string;
  triangles: number;
  surfaceArea: number;
  diagonal: number;
  classification: AssemblyOwnershipClassification;
}

export interface AssemblyCoveragePhaseRow {
  phase: string;
  ownedMeshes: string[];
}

export interface AssemblyCoverageReport {
  schemaVersion: 1;
  profile: ProfileId;
  passed: boolean;
  phases: AssemblyCoveragePhaseRow[];
  unresolved: AssemblyCoverageEntry[];
  excludedInsignificant: Array<Pick<AssemblyCoverageEntry, "objectId" | "triangles">>;
  entries: AssemblyCoverageEntry[];
}

const TANK_BUILDER_PHASES = ["hull", "turret", "gun", "running-gear", "tracks"] as const;

function triangleArea(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): number {
  return Math.hypot(
    (by - ay) * (cz - az) - (bz - az) * (cy - ay),
    (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax),
  ) / 2;
}

/**
 * Resolves the owning phase for one oracle mesh by walking to its nearest semantic marker
 * (honoring the logicalOwner overlay) and consulting the single authoritative ownership
 * resolver shared with phase scope/composition/hashing.
 */
function resolveOwningPhase(object: THREE.Object3D, profile: ProfileId): string | null {
  if (profile !== "tank") return null;
  const phases = TANK_BUILDER_PHASES as readonly string[];
  let current: THREE.Object3D | null = object;
  while (current) {
    // Explicit logical-owner redirection wins over the physical hierarchy.
    if (typeof current.userData.logicalOwner === "string") {
      const target = current.userData.logicalOwner as string;
      let resolved: THREE.Object3D | undefined;
      object.parent?.traverse((candidate) => {
        if (!resolved && candidate.userData.semanticId === target) resolved = candidate;
      });
      if (resolved || current.userData.semanticId === target) {
        const owner = resolved ?? current;
        const id = typeof owner.userData.semanticId === "string" ? owner.userData.semanticId as string : target;
        const role = typeof owner.userData.semanticRole === "string" ? owner.userData.semanticRole as string : undefined;
        for (const phase of phases) {
          const allows = phaseOwnedSemantics(profile, phase);
          if (allows?.(id, role)) return phase;
        }
        return null;
      }
    }
    const id = typeof current.userData.semanticId === "string" ? current.userData.semanticId as string : undefined;
    if (id) {
      const role = typeof current.userData.semanticRole === "string" ? current.userData.semanticRole as string : undefined;
      for (const phase of phases) {
        const allows = phaseOwnedSemantics(profile, phase);
        if (allows?.(id, role)) return phase;
      }
      return null;
    }
    current = current.parent;
  }
  return null;
}

export function evaluateAssemblyCoverage(root: THREE.Object3D, profile: ProfileId): AssemblyCoverageReport {
  root.updateMatrixWorld(true);
  type Raw = { mesh: THREE.Object3D; objectId: string; meshName: string; triangles: number; surfaceArea: number; diagonal: number };
  const raws: Raw[] = [];
  let totalArea = 0;
  let maxDiagonal = 0;
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const world = new THREE.Vector3();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
    const position = mesh.geometry.getAttribute("position");
    if (!position) return;
    const index = mesh.geometry.index;
    const triangles = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    if (!triangles) return;
    let area = 0;
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let triangle = 0; triangle < triangles; triangle += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertexIndex = index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner;
        world.fromBufferAttribute(position, vertexIndex).applyMatrix4(mesh.matrixWorld);
        min.min(world);
        max.max(world);
        vertices[corner]!.copy(world);
      }
      const [a, b, c] = vertices as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
      area += triangleArea(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
    const diagonal = min.distanceTo(max);
    totalArea += area;
    maxDiagonal = Math.max(maxDiagonal, diagonal);
    raws.push({ mesh: object, objectId: nearestSemanticObjectId(root, object), meshName: mesh.name || object.name || mesh.uuid, triangles, surfaceArea: area, diagonal });
  });
  const entries: AssemblyCoverageEntry[] = raws.map(({ mesh, ...raw }) => {
    const insignificant = raw.surfaceArea < totalArea * 0.005 && raw.diagonal < maxDiagonal * 0.05;
    const phase = resolveOwningPhase(mesh, profile);
    const classification: AssemblyOwnershipClassification = phase
      ? { kind: "owned", phase }
      : insignificant && profile === "tank"
        ? { kind: "insignificant-excluded" }
        : { kind: "unresolved" };
    return { ...raw, classification };
  });
  const phases = (profile === "tank" ? [...TANK_BUILDER_PHASES] : []).map((phase) => ({
    phase,
    ownedMeshes: entries.filter((entry) => entry.classification.kind === "owned" && entry.classification.phase === phase).map((entry) => entry.meshName),
  }));
  const unresolved = entries.filter((entry) => entry.classification.kind === "unresolved");
  return {
    schemaVersion: 1,
    profile,
    passed: unresolved.length === 0,
    phases,
    unresolved,
    excludedInsignificant: entries.filter((entry) => entry.classification.kind === "insignificant-excluded").map(({ objectId, triangles }) => ({ objectId, triangles })),
    entries,
  };
}

function nearestSemanticObjectId(root: THREE.Object3D, mesh: THREE.Object3D): string {
  let current: THREE.Object3D | null = mesh;
  while (current) {
    const semanticId = typeof current.userData.semanticId === "string" ? current.userData.semanticId : undefined;
    if (semanticId) return semanticId;
    current = current.parent;
  }
  return mesh.name || mesh.uuid;
}

/** Throws a coverage violation listing every unresolved significant source mesh. */
export function assertAssemblyCoverage(root: THREE.Object3D, profile: ProfileId): AssemblyCoverageReport {
  const report = evaluateAssemblyCoverage(root, profile);
  if (!report.passed) {
    const listed = report.unresolved.map((entry) => `${entry.meshName} (${entry.triangles} tris, ${entry.objectId})`).join("; ");
    throw new Error(`semantic assembly coverage failed: ${report.unresolved.length} significant source mesh(es) are not owned by any phase and not excluded as insignificant: ${listed}. Map them with onboard/repair-oracle or mark them explicitly insignificant.`);
  }
  return report;
}

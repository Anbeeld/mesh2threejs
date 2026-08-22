import { createHash } from "node:crypto";
import type * as THREE from "three";
import { snapshotScene } from "./geometry.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(Number(value.toFixed(9)));
  return JSON.stringify(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprintScene(root: THREE.Object3D): string {
  const snapshot = snapshotScene(root);
  const payload = {
    metadata: snapshot.metadata,
    components: Object.values(snapshot.components)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, role, parentSemanticId, critical }) => ({ id, role, parentSemanticId, critical })),
    triangles: snapshot.triangles.map((triangle) => ({
      componentId: triangle.componentId,
      materialId: triangle.materialId,
      color: triangle.color,
      roughness: triangle.roughness,
      points: triangle.points,
    })),
  };
  return sha256(canonicalJson(payload));
}

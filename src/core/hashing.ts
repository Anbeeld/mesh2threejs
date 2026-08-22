import { createHash } from "node:crypto";
import type * as THREE from "three";
import { snapshotScene } from "./geometry.js";
import type { SceneSnapshot } from "../types.js";

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
  return fingerprintSnapshot(snapshot);
}

export function fingerprintSnapshot(snapshot: SceneSnapshot, semanticIds?: ReadonlySet<string>, options: { includeMaterials?: boolean } = {}): string {
  const components = Object.values(snapshot.components).filter((component) => !semanticIds || semanticIds.has(component.id)).sort((a, b) => a.id.localeCompare(b.id));
  const hash = createHash("sha256");
  hash.update(canonicalJson({
    metadata: snapshot.metadata,
    components: components.map(({ id, role, parentSemanticId, critical, origin, representation }) => ({ id, role, parentSemanticId, critical, origin, ...(options.includeMaterials === false ? {} : { representation }) })),
  }));
  const positions = Buffer.from(snapshot.triangleData.positions.buffer, snapshot.triangleData.positions.byteOffset, snapshot.triangleData.positions.byteLength);
  const materialIndices = Buffer.from(snapshot.triangleData.materialIndices.buffer, snapshot.triangleData.materialIndices.byteOffset, snapshot.triangleData.materialIndices.byteLength);
  const colors = Buffer.from(snapshot.triangleData.colors.buffer, snapshot.triangleData.colors.byteOffset, snapshot.triangleData.colors.byteLength);
  const roughness = Buffer.from(snapshot.triangleData.roughness.buffer, snapshot.triangleData.roughness.byteOffset, snapshot.triangleData.roughness.byteLength);
  const updateRun = (start: number, endExclusive: number): void => {
    hash.update(positions.subarray(start * 9 * Float64Array.BYTES_PER_ELEMENT, endExclusive * 9 * Float64Array.BYTES_PER_ELEMENT));
    if (options.includeMaterials !== false) {
      hash.update(materialIndices.subarray(start * Uint32Array.BYTES_PER_ELEMENT, endExclusive * Uint32Array.BYTES_PER_ELEMENT));
      hash.update(colors.subarray(start * Uint32Array.BYTES_PER_ELEMENT, endExclusive * Uint32Array.BYTES_PER_ELEMENT));
      hash.update(roughness.subarray(start * Float32Array.BYTES_PER_ELEMENT, endExclusive * Float32Array.BYTES_PER_ELEMENT));
    }
  };
  for (const component of components) {
    hash.update(component.id);
    let runStart: number | undefined;
    let previous: number | undefined;
    for (const triangleIndex of component.triangleIndices) {
      const physicalIndex = snapshot.triangleSelection?.[triangleIndex] ?? triangleIndex;
      if (runStart === undefined) runStart = physicalIndex;
      else if (previous !== undefined && physicalIndex !== previous + 1) { updateRun(runStart, previous + 1); runStart = physicalIndex; }
      previous = physicalIndex;
    }
    if (runStart !== undefined && previous !== undefined) updateRun(runStart, previous + 1);
  }
  return hash.digest("hex");
}

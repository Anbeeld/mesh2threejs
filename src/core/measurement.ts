import * as THREE from "three";
import type { Axis, Bounds3, CaptureFrame, Point3, SceneComponent, SceneSnapshot } from "../types.js";
import { boundsFromPoints, forEachSceneTriangle, forEachSceneTriangleReusable, sceneTriangleAt } from "./geometry.js";

const axisIndex: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

export function measureBounds(snapshot: SceneSnapshot, filter?: (component: SceneComponent) => boolean): Bounds3 {
  const components = Object.values(snapshot.components).filter((component) => !filter || filter(component));
  return boundsFromPoints(components.flatMap((component) => [component.bounds.min, component.bounds.max]));
}

export function measureRobustBounds(snapshot: SceneSnapshot, options: { exclude?: RegExp; trimFraction?: number } = {}): Bounds3 {
  const components = Object.values(snapshot.components).filter((component) => !options.exclude?.test(component.id) && component.triangleIndices.length > 0);
  if (!components.length) return boundsFromPoints([]);
  const trim = Math.max(0, Math.min(0.1, options.trimFraction ?? 0.002));
  const min: Point3 = [0, 1, 2].map((axis) => {
    const values = components.map((component) => component.bounds.min[axis]!).sort((a, b) => a - b);
    return values[Math.floor((values.length - 1) * trim)]!;
  }) as Point3;
  const max: Point3 = [0, 1, 2].map((axis) => {
    const values = components.map((component) => component.bounds.max[axis]!).sort((a, b) => a - b);
    return values[Math.ceil((values.length - 1) * (1 - trim))]!;
  }) as Point3;
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], center: [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2] };
}

export interface SectionRequest {
  axis: Axis;
  position: number;
  thickness: number;
  semanticIds?: string[];
}

export interface SectionMeasurement extends Bounds3 {
  axis: Axis;
  position: number;
  thickness: number;
  sampleCount: number;
}

function interpolatePlane(a: Point3, b: Point3, axis: 0 | 1 | 2, position: number): Point3 | null {
  const av = a[axis];
  const bv = b[axis];
  if ((av < position && bv < position) || (av > position && bv > position)) return null;
  const delta = bv - av;
  if (Math.abs(delta) < 1e-12) return Math.abs(av - position) < 1e-12 ? [...a] : null;
  const t = (position - av) / delta;
  if (t < 0 || t > 1) return null;
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function measureSection(snapshot: SceneSnapshot, request: SectionRequest): SectionMeasurement {
  const axis = axisIndex[request.axis];
  const selected = request.semanticIds ? new Set(request.semanticIds) : null;
  const points: Point3[] = [];
  forEachSceneTriangle(snapshot, (triangle) => {
    if (selected && !selected.has(triangle.componentId)) return;
    const [a, b, c] = triangle.points;
    for (const point of triangle.points) {
      if (Math.abs(point[axis] - request.position) <= request.thickness / 2) points.push(point);
    }
    for (const [start, end] of [[a, b], [b, c], [c, a]] as const) {
      const point = interpolatePlane(start, end, axis, request.position);
      if (point) points.push(point);
    }
  });
  const bounds = boundsFromPoints(points);
  return { ...bounds, axis: request.axis, position: request.position, thickness: request.thickness, sampleCount: points.length };
}

function boundsGap(a: Bounds3, b: Bounds3): number {
  let squared = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const gap = Math.max(0, (a.min[axis] ?? 0) - (b.max[axis] ?? 0), (b.min[axis] ?? 0) - (a.max[axis] ?? 0));
    squared += gap * gap;
  }
  return Math.sqrt(squared);
}

export interface AttachmentContract {
  child: string;
  parent: string;
  maxGap: number;
}

export function checkAttachments(snapshot: SceneSnapshot, contracts: AttachmentContract[]): Array<AttachmentContract & { gap: number; passed: boolean }> {
  return contracts.map((contract) => {
    const child = snapshot.components[contract.child];
    const parent = snapshot.components[contract.parent];
    const gap = child && parent ? boundsGap(child.bounds, parent.bounds) : Number.POSITIVE_INFINITY;
    return { ...contract, gap, passed: gap <= contract.maxGap };
  });
}

export type SemanticTransforms = Record<string, number[]>;

export function captureSemanticTransforms(root: THREE.Object3D): SemanticTransforms {
  root.updateMatrixWorld(true);
  const transforms: SemanticTransforms = {};
  root.traverse((object) => {
    if (typeof object.userData.semanticId === "string") {
      transforms[object.userData.semanticId] = object.matrixWorld.elements.map((value) => Number(value.toFixed(12)));
    }
  });
  return transforms;
}

function matrixDistance(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  return Math.max(...a.map((value, index) => Math.abs(value - (b[index] ?? 0))));
}

export function checkArticulation(
  before: SemanticTransforms,
  after: SemanticTransforms,
  contract: { moving: string[]; stationary: string[]; epsilon: number },
): { passed: boolean; rows: Array<{ semanticId: string; expected: "moving" | "stationary"; delta: number; passed: boolean }> } {
  const rows = [
    ...contract.moving.map((semanticId) => {
      const delta = matrixDistance(before[semanticId], after[semanticId]);
      return { semanticId, expected: "moving" as const, delta, passed: Boolean(before[semanticId] && after[semanticId]) && delta > contract.epsilon };
    }),
    ...contract.stationary.map((semanticId) => {
      const delta = matrixDistance(before[semanticId], after[semanticId]);
      return { semanticId, expected: "stationary" as const, delta, passed: delta <= contract.epsilon };
    }),
  ];
  return { passed: rows.every((row) => row.passed), rows };
}

export function compareMasks(oracle: CaptureFrame, candidate: CaptureFrame): {
  iou: number;
  missingRatio: number;
  excessRatio: number;
  intersection: number;
  union: number;
} {
  if (oracle.width !== candidate.width || oracle.height !== candidate.height) throw new Error("mask dimensions differ");
  let intersection = 0;
  let union = 0;
  let missing = 0;
  let excess = 0;
  for (let pixel = 0; pixel < oracle.width * oracle.height; pixel += 1) {
    const o = (oracle.data[pixel * 4 + 3] ?? 0) > 0;
    const c = (candidate.data[pixel * 4 + 3] ?? 0) > 0;
    if (o && c) intersection += 1;
    if (o || c) union += 1;
    if (o && !c) missing += 1;
    if (!o && c) excess += 1;
  }
  return {
    iou: union ? intersection / union : 1,
    missingRatio: union ? missing / union : 0,
    excessRatio: union ? excess / union : 0,
    intersection,
    union,
  };
}

export function silhouetteCurves(frame: CaptureFrame): {
  columns: Array<{ top: number; bottom: number } | null>;
  rows: Array<{ left: number; right: number } | null>;
} {
  const present = (x: number, y: number): boolean => (frame.data[(y * frame.width + x) * 4 + 3] ?? 0) > 0;
  const columns = Array.from({ length: frame.width }, (_, x) => {
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < frame.height; y += 1) {
      if (!present(x, y)) continue;
      if (top < 0) top = y;
      bottom = y;
    }
    return top < 0 ? null : { top, bottom };
  });
  const rows = Array.from({ length: frame.height }, (_, y) => {
    let left = -1;
    let right = -1;
    for (let x = 0; x < frame.width; x += 1) {
      if (!present(x, y)) continue;
      if (left < 0) left = x;
      right = x;
    }
    return left < 0 ? null : { left, right };
  });
  return { columns, rows };
}

function roundedPoint(point: Point3): string {
  return point.map((value) => Number(value.toFixed(7))).join(",");
}

export function checkWatertightness(snapshot: SceneSnapshot, semanticIds?: string[]): Array<{ componentId: string; boundaryEdges: number; passed: boolean }> {
  const selected = semanticIds ? new Set(semanticIds) : null;
  const edgesByComponent = new Map<string, Map<string, number>>();
  forEachSceneTriangle(snapshot, (triangle) => {
    if (selected && !selected.has(triangle.componentId)) return;
    let edges = edgesByComponent.get(triangle.componentId);
    if (!edges) {
      edges = new Map();
      edgesByComponent.set(triangle.componentId, edges);
    }
    const [a, b, c] = triangle.points;
    for (const [start, end] of [[a, b], [b, c], [c, a]] as const) {
      const key = [roundedPoint(start), roundedPoint(end)].sort().join("|");
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  });
  return [...edgesByComponent].map(([componentId, edges]) => {
    const boundaryEdges = [...edges.values()].filter((count) => count === 1).length;
    return { componentId, boundaryEdges, passed: boundaryEdges === 0 };
  });
}

export function measureLandmarks(snapshot: SceneSnapshot, request: { semanticPattern: RegExp; axis: Axis }): {
  minimum: number;
  maximum: number;
  centers: Point3[];
} {
  const axis = axisIndex[request.axis];
  const components = Object.values(snapshot.components)
    .filter((component) => request.semanticPattern.test(component.id))
    .sort((a, b) => a.bounds.center[axis] - b.bounds.center[axis]);
  return {
    minimum: components.length ? Math.min(...components.map((component) => component.bounds.min[axis])) : Number.NaN,
    maximum: components.length ? Math.max(...components.map((component) => component.bounds.max[axis])) : Number.NaN,
    centers: components.map((component) => component.bounds.center),
  };
}

/** Translation-invariant signed volume; its sign exposes a physical reflection. */
export function measureSignedVolume(snapshot: SceneSnapshot): number {
  const origin = measureBounds(snapshot).center;
  let volume = 0;
  forEachSceneTriangleReusable(snapshot, (triangle) => {
    const [a, b, c] = triangle.points;
    const ax = a[0] - origin[0]; const ay = a[1] - origin[1]; const az = a[2] - origin[2];
    const bx = b[0] - origin[0]; const by = b[1] - origin[1]; const bz = b[2] - origin[2];
    const cx = c[0] - origin[0]; const cy = c[1] - origin[1]; const cz = c[2] - origin[2];
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  });
  return volume;
}

export function countConnectedIslands(snapshot: SceneSnapshot, semanticId: string): number {
  const component = snapshot.components[semanticId];
  if (!component?.triangleIndices.length) return 0;
  const parent = new Int32Array(component.triangleIndices.length);
  for (let index = 0; index < parent.length; index += 1) parent[index] = index;
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[value] !== value) { const next = parent[value]!; parent[value] = root; value = next; }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  const owners = new Map<string, number>();
  for (let triangleIndex = 0; triangleIndex < component.triangleIndices.length; triangleIndex += 1) {
    const localTriangle = component.triangleIndices[triangleIndex]!;
    const physicalTriangle = snapshot.triangleSelection?.[localTriangle] ?? localTriangle;
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      const offset = physicalTriangle * 9 + vertexIndex * 3;
      const vertex = `${snapshot.triangleData.positions[offset]!.toFixed(7)},${snapshot.triangleData.positions[offset + 1]!.toFixed(7)},${snapshot.triangleData.positions[offset + 2]!.toFixed(7)}`;
      const owner = owners.get(vertex);
      if (owner === undefined) owners.set(vertex, triangleIndex);
      else union(owner, triangleIndex);
    }
  }
  let islands = 0;
  for (let index = 0; index < parent.length; index += 1) if (find(index) === index) islands += 1;
  return islands;
}

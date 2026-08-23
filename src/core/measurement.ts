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

export function countConnectedIslands(snapshot: SceneSnapshot, semanticId: string): number {  const component = snapshot.components[semanticId];
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

/** 2D point in the section plane (u, v), where the plane normal is the section axis. */
export type Point2 = [number, number];

export interface SectionSegmentsRequest {
  axis: Axis;
  position: number;
  semanticIds?: string[];
}

/**
 * True triangle-plane intersection: every triangle crossing the plane contributes one 2D line
 * segment projected into plane coordinates. This is independent of mesh tessellation density —
 * a vertex does not need to lie near the plane for the surface to be measured.
 */
export function measureSectionSegments(snapshot: SceneSnapshot, request: SectionSegmentsRequest): Array<[Point2, Point2]> {
  const axis = axisIndex[request.axis];
  const selected = request.semanticIds ? new Set(request.semanticIds) : null;
  const position = request.position;
  const segments: Array<[Point2, Point2]> = [];
  forEachSceneTriangleReusable(snapshot, (triangle) => {
    if (selected && !selected.has(triangle.componentId)) return;
    const [a, b, c] = triangle.points;
    const crossings: Point3[] = [];
    for (const [start, end] of [[a, b], [b, c], [c, a]] as const) {
      const sv = start[axis]! - position;
      const ev = end[axis]! - position;
      if ((sv < 0 && ev < 0) || (sv > 0 && ev > 0)) continue;
      const delta = ev - sv;
      let point: Point3 | undefined;
      if (Math.abs(delta) < 1e-12) {
        if (Math.abs(sv) < 1e-12) point = [...end];
      } else {
        const t = -sv / delta;
        if (t >= 0 && t <= 1) point = [0, 1, 2].map((axis_) => start[axis_]! + (end[axis_]! - start[axis_]!) * t) as Point3;
      }
      if (point) crossings.push(point);
    }
    const unique = crossings.filter((point, index) => !crossings.slice(0, index).some((other) => Math.hypot(point[0]! - other[0]!, point[1]! - other[1]!, point[2]! - other[2]!) < 1e-9));
    if (unique.length >= 2) {
      const project = (point: Point3): Point2 => {
        const axes = [0, 1, 2].filter((value) => value !== axis);
        return [point[axes[0]!]!, point[axes[1]!]!];
      };
      segments.push([project(unique[0]!), project(unique[1]!)]);
    }
  });
  return segments;
}

export interface SectionContour {
  min: Point2;
  max: Point2;
  width: number;
  height: number;
  /** Even-odd filled occupancy mask over a regular width×height grid spanning [min, max]. */
  mask: Uint8Array;
}

function contourCell(contour: SectionContour, u: number, v: number): boolean {
  const column = Math.min(contour.width - 1, Math.max(0, Math.floor(u * contour.width)));
  const row = Math.min(contour.height - 1, Math.max(0, Math.floor(v * contour.height)));
  return contour.mask[row * contour.width + column] === 1;
}

function contourBandWidths(contour: SectionContour): { w: number; h: number; upper: number; lower: number } {
  const spanU = contour.max[0]! - contour.min[0]!;
  const spanV = contour.max[1]! - contour.min[1]!;
  const rowRange = (fromRow: number, toRow: number): number => {
    let minColumn = Infinity;
    let maxColumn = -Infinity;
    for (let row = fromRow; row <= toRow; row += 1) {
      for (let column = 0; column < contour.width; column += 1) {
        if (contour.mask[row * contour.width + column] !== 1) continue;
        minColumn = Math.min(minColumn, column);
        maxColumn = Math.max(maxColumn, column);
      }
    }
    return Number.isFinite(minColumn) ? ((maxColumn - minColumn + 1) / contour.width) * spanU : 0;
  };
  return { w: spanU, h: spanV, upper: rowRange(Math.floor(contour.height / 2), contour.height - 1), lower: rowRange(0, Math.floor(contour.height / 2) - 1) };
}

/**
 * Rasterizes intersection segments into a deterministic occupancy mask using even-odd row
 * filling. Closed surface intersections fill correctly regardless of how many disjoint loops
 * or joined components cross the plane. Returns null when the plane has insufficient evidence.
 */
export function sectionContourFromSegments(segments: Array<[Point2, Point2]>, resolution = 96): SectionContour | null {
  if (segments.length < 3 || resolution < 8) return null;
  const min: Point2 = [Infinity, Infinity];
  const max: Point2 = [-Infinity, -Infinity];
  for (const [start, end] of segments) for (const point of [start, end]) {
    min[0] = Math.min(min[0]!, point[0]); min[1] = Math.min(min[1]!, point[1]);
    max[0] = Math.max(max[0]!, point[0]); max[1] = Math.max(max[1]!, point[1]);
  }
  const spanU = max[0]! - min[0]!;
  const spanV = max[1]! - min[1]!;
  const scale = resolution / Math.max(spanU, spanV, 1e-9);
  const width = Math.max(4, Math.ceil(spanU * scale));
  const height = Math.max(4, Math.ceil(spanV * scale));
  const mask = new Uint8Array(width * height);
  // Dense segment sampling plus even-odd parity per pixel-row center.
  const samplesPerSegment = 24;
  for (let row = 0; row < height; row += 1) {
    const v = min[1]! + ((row + 0.5) / height) * spanV;
    const crossings: number[] = [];
    for (const [start, end] of segments) {
      const v0 = start[1];
      const v1 = end[1];
      if ((v0! <= v && v1! > v) || (v1! <= v && v0! > v)) {
        const t = (v - v0!) / (v1! - v0!);
        crossings.push(start[0]! + (end[0]! - start[0]!) * t);
      }
    }
    if (!crossings.length) continue;
    crossings.sort((a, b) => a - b);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const from = crossings[index]!;
      const to = crossings[index + 1]!;
      const cellFrom = Math.max(0, Math.floor(((from - min[0]!) / spanU) * width));
      const cellTo = Math.min(width - 1, Math.ceil(((to - min[0]!) / spanU) * width) - 1);
      for (let column = cellFrom; column <= cellTo; column += 1) mask[row * width + column] = 1;
    }
  }
  // Boundary reinforcement keeps thin features visible at low resolution.
  for (const [start, end] of segments) {
    for (let sample = 0; sample <= samplesPerSegment; sample += 1) {
      const t = sample / samplesPerSegment;
      const u = start[0]! + (end[0]! - start[0]!) * t;
      const v = start[1]! + (end[1]! - start[1]!) * t;
      const column = Math.min(width - 1, Math.max(0, Math.floor(((u - min[0]!) / spanU) * width)));
      const row = Math.min(height - 1, Math.max(0, Math.floor(((v - min[1]!) / spanV) * height)));
      mask[row * width + column] = 1;
    }
  }
  const filled = mask.reduce((sum, value) => sum + value, 0);
  if (filled < width * height * 0.02) return null;
  return { min: [...min] as Point2, max: [...max] as Point2, width, height, mask };
}

/**
 * Compares two section contours by shape after normalizing each to its own extents, so
 * topology density and absolute scale differences do not dominate. Returns an IoU-style
 * agreement plus physical band errors (width/height/upper/lower widths). There is no AABB
 * fallback: callers must treat null contours as insufficient section evidence.
 */
export function compareSectionContours(
  oracle: SectionContour,
  candidate: SectionContour,
): { shapeAgreement: number; widthError: number; heightError: number; upperWidthError: number; lowerWidthError: number } {
  const sampleCount = 64;
  let union = 0;
  let intersection = 0;
  for (let iu = 0; iu < sampleCount; iu += 1) {
    for (let iv = 0; iv < sampleCount; iv += 1) {
      const u = (iu + 0.5) / sampleCount;
      const v = (iv + 0.5) / sampleCount;
      const o = contourCell(oracle, u, v);
      const c = contourCell(candidate, u, v);
      if (o || c) union += 1;
      if (o && c) intersection += 1;
    }
  }
  const relative = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(a), 1e-9);
  const oBands = contourBandWidths(oracle);
  const cBands = contourBandWidths(candidate);
  return {
    shapeAgreement: union ? intersection / union : 0,
    widthError: relative(oBands.w, cBands.w),
    heightError: relative(oBands.h, cBands.h),
    upperWidthError: relative(oBands.upper, cBands.upper),
    lowerWidthError: relative(oBands.lower, cBands.lower),
  };
}

export interface PrincipalPlane {
  /** Unit normal. */
  normal: Point3;
  /** Plane offset along the normal (d in n·x + d = 0 with outward orientation). */
  offset: number;
  area: number;
  centroid: Point3;
  /** Maximum distance of member triangle centroids from the area-weighted centroid. */
  supportRadius: number;
}

export interface PrincipalPlaneOptions {
  semanticIds?: string[];
  /** Clusters below this fraction of total area are ignored as detail surfaces. */
  areaFloorFraction?: number;
  /** Normal angular tolerance in degrees for coplanarity clustering. */
  angularToleranceDegrees?: number;
  /** Plane-offset tolerance (object units) for coplanarity clustering. */
  offsetTolerance?: number;
}

/**
 * Area-weighted principal-plane extraction. Every hull triangle contributes its world normal,
 * area, offset, and centroid to an approximately-coplanar cluster; clusters aggregate physical
 * surface area instead of triangle counts, so identical geometry yields identical planes under
 * any tessellation, and triangles cannot game a normal histogram by sitting in wrong locations.
 */
export function extractPrincipalPlanes(snapshot: SceneSnapshot, options: PrincipalPlaneOptions = {}): PrincipalPlane[] {
  const selected = options.semanticIds ? new Set(options.semanticIds) : null;
  const angularCos = Math.cos(((options.angularToleranceDegrees ?? 8) * Math.PI) / 180);
  const scaleHint = measureBounds(snapshot, selected ? (component) => selected.has(component.id) : undefined);
  const offsetTolerance = options.offsetTolerance ?? Math.max(...scaleHint.size.filter(Number.isFinite), 1e-6) * 0.01;
  // First aggregate triangles into quantized (normal-grid, offset-bin) buckets. Quantization is
  // a pure function of geometry, so any tessellation of the same surfaces populates the same
  // buckets; only then are buckets greedily merged into principal clusters.
  type Bucket = { nx: number; ny: number; nz: number; offset: number; area: number; cx: number; cy: number; cz: number };
  const buckets = new Map<string, Bucket>();
  forEachSceneTriangleReusable(snapshot, (triangle) => {
    if (selected && !selected.has(triangle.componentId)) return;
    const [a, b, c] = triangle.points;
    const abx = b[0]! - a[0]!; const aby = b[1]! - a[1]!; const abz = b[2]! - a[2]!;
    const acx = c[0]! - a[0]!; const acy = c[1]! - a[1]!; const acz = c[2]! - a[2]!;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const cross = Math.hypot(nx, ny, nz);
    if (cross < 1e-12) return;
    const area = cross / 2;
    nx /= cross; ny /= cross; nz /= cross;
    // Snap floating-point noise on near-degenerate components so canonical orientation and
    // quantized buckets are stable across tessellations.
    nx = Math.abs(nx) < 1e-6 ? 0 : nx; ny = Math.abs(ny) < 1e-6 ? 0 : ny; nz = Math.abs(nz) < 1e-6 ? 0 : nz;
    // Canonicalize orientation so opposite-facing coincident planes merge.
    if (ny < 0 || (Math.abs(ny) < 1e-12 && (nx < 0 || (Math.abs(nx) < 1e-12 && nz < 0)))) { nx = -nx; ny = -ny; nz = -nz; }
    const centroid: Point3 = [(a[0]! + b[0]! + c[0]!) / 3, (a[1]! + b[1]! + c[1]!) / 3, (a[2]! + b[2]! + c[2]!) / 3];
    const offset = -(nx * a[0]! + ny * a[1]! + nz * a[2]!);
    const grid = 12;
    const key = `${Math.round(nx * grid)},${Math.round(ny * grid)},${Math.round(nz * grid)},${Math.round(offset / offsetTolerance)}`;
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { nx: nx * area, ny: ny * area, nz: nz * area, offset: offset * area, area, cx: centroid[0]! * area, cy: centroid[1]! * area, cz: centroid[2]! * area });
    } else {
      bucket.nx += nx * area; bucket.ny += ny * area; bucket.nz += nz * area;
      bucket.offset += offset * area;
      bucket.cx += centroid[0]! * area; bucket.cy += centroid[1]! * area; bucket.cz += centroid[2]! * area;
      bucket.area += area;
    }
  });
  const ordered = [...buckets.values()].sort((first, second) => second.area - first.area);
  type Draft = { nx: number; ny: number; nz: number; offset: number; area: number; cx: number; cy: number; cz: number };
  const drafts: Draft[] = [];
  for (const bucket of ordered) {
    let bnx = bucket.nx / bucket.area;
    let bny = bucket.ny / bucket.area;
    let bnz = bucket.nz / bucket.area;
    const length = Math.hypot(bnx, bny, bnz) || 1;
    bnx /= length; bny /= length; bnz /= length;
    const boffset = bucket.offset / bucket.area;
    let target: Draft | undefined;
    for (const draft of drafts) {
      const cosine = draft.nx * bnx + draft.ny * bny + draft.nz * bnz;
      if (cosine < angularCos) continue;
      if (Math.abs(draft.offset - boffset) > offsetTolerance) continue;
      target = draft;
      break;
    }
    if (!target) {
      target = { nx: 0, ny: 0, nz: 0, offset: 0, area: 0, cx: 0, cy: 0, cz: 0 };
      drafts.push(target);
    }
    const weight = target.area + bucket.area;
    target.nx = (target.nx * target.area + bnx * bucket.area) / weight;
    target.ny = (target.ny * target.area + bny * bucket.area) / weight;
    target.nz = (target.nz * target.area + bnz * bucket.area) / weight;
    const normalLength = Math.hypot(target.nx, target.ny, target.nz) || 1;
    target.nx /= normalLength; target.ny /= normalLength; target.nz /= normalLength;
    target.offset = (target.offset * target.area + boffset * bucket.area) / weight;
    target.cx = (target.cx * target.area + bucket.cx) / weight;
    target.cy = (target.cy * target.area + bucket.cy) / weight;
    target.cz = (target.cz * target.area + bucket.cz) / weight;
    target.area = weight;
  }
  const totalArea = drafts.reduce((sum, draft) => sum + draft.area, 0);
  const floor = (options.areaFloorFraction ?? 0.04) * totalArea;
  const significant = drafts.filter((draft) => draft.area >= floor);
  return significant.map((draft) => ({ normal: [draft.nx, draft.ny, draft.nz], offset: draft.offset, area: draft.area, centroid: [draft.cx, draft.cy, draft.cz], supportRadius: supportRadiusFor(draft) }));

  function supportRadiusFor(draft: Draft): number {
    const angularCosLocal = Math.cos(((options.angularToleranceDegrees ?? 8) * Math.PI) / 180);
    let support = 0;
    forEachSceneTriangleReusable(snapshot, (triangle) => {
      if (selected && !selected.has(triangle.componentId)) return;
      const [a, b, c] = triangle.points;
      const abx = b[0]! - a[0]!; const aby = b[1]! - a[1]!; const abz = b[2]! - a[2]!;
      const acx = c[0]! - a[0]!; const acy = c[1]! - a[1]!; const acz = c[2]! - a[2]!;
      let nx = aby * acz - abz * acy;
      let ny = abz * acx - abx * acz;
      let nz = abx * acy - aby * acx;
      const cross = Math.hypot(nx, ny, nz);
      if (cross < 1e-12) return;
      nx /= cross; ny /= cross; nz /= cross;
      nx = Math.abs(nx) < 1e-6 ? 0 : nx; ny = Math.abs(ny) < 1e-6 ? 0 : ny; nz = Math.abs(nz) < 1e-6 ? 0 : nz;
      if (ny < 0 || (Math.abs(ny) < 1e-12 && (nx < 0 || (Math.abs(nx) < 1e-12 && nz < 0)))) { nx = -nx; ny = -ny; nz = -nz; }
      if (nx * draft.nx + ny * draft.ny + nz * draft.nz < angularCosLocal) return;
      const offset = -(nx * a[0]! + ny * a[1]! + nz * a[2]!);
      if (Math.abs(draft.offset - offset) > offsetTolerance) return;
      const centroid: Point3 = [(a[0]! + b[0]! + c[0]!) / 3, (a[1]! + b[1]! + c[1]!) / 3, (a[2]! + b[2]! + c[2]!) / 3];
      support = Math.max(support, Math.hypot(centroid[0]! - draft.cx, centroid[1]! - draft.cy, centroid[2]! - draft.cz));
    });
    return support;
  }
}

/** Cost of matching a candidate plane to an oracle plane; lower is better, Infinity never matches. */
export function principalPlaneMatchCost(scale: number, oracle: PrincipalPlane, candidate: PrincipalPlane): number {
  const cosine = oracle.normal[0]! * candidate.normal[0]! + oracle.normal[1]! * candidate.normal[1]! + oracle.normal[2]! * candidate.normal[2]!;
  if (cosine < Math.cos(Math.PI / 12)) return Number.POSITIVE_INFINITY;
  const angleCost = 1 - cosine;
  const offsetCost = Math.abs(oracle.offset - candidate.offset) / Math.max(scale, 1e-9);
  const centroidCost = Math.hypot(oracle.centroid[0]! - candidate.centroid[0]!, oracle.centroid[1]! - candidate.centroid[1]!, oracle.centroid[2]! - candidate.centroid[2]!) / Math.max(scale, 1e-9);
  const areaRatio = candidate.area / Math.max(oracle.area, 1e-9);
  const coverageCost = Math.abs(Math.min(areaRatio, 2) - 1);
  return angleCost * 4 + offsetCost * 4 + centroidCost * 0.5 + coverageCost;
}

export interface WheelRadialProfile {
  center: Point3;
  /** Measured thin/extrusion axis: 0=x, 1=y, 2=z. */
  axleAxis: 0 | 1 | 2;
  axleAlignedWithX: boolean;
  meanRadius: number;
  /** Relative range of per-angle maximum radii around the wheel plane. */
  radialRange: number;
  /** Fraction of angular bins whose maximum radius reaches at least 20% of the mean radius. */
  circumferenceCoverage: number;
  sampleCount: number;
}

/**
 * Physical wheel truth: determines the extrusion axis from coordinate spread, projects the
 * geometry into the wheel plane around the measured center, and measures a per-angle maximum
 * radius profile from densely sampled projected triangle edges. Primitive metadata plays no
 * part, so an octagonal wheel passes while any cuboid — subdivided or not — fails decisively.
 */
export function measureWheelRadialProfile(snapshot: SceneSnapshot, semanticId: string, bins = 24): WheelRadialProfile | null {
  const component = snapshot.components[semanticId];
  if (!component?.triangleIndices.length) return null;
  const spreads: [number, number, number] = [0, 0, 0];
  const sums: [number, number, number] = [0, 0, 0];
  const squared: [number, number, number] = [0, 0, 0];
  let count = 0;
  const points: Point3[] = [];
  for (const index of component.triangleIndices) {
    const triangle = sceneTriangleAt(snapshot, index);
    if (!triangle) continue;
    for (const point of triangle.points) {
      points.push(point);
      for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) sums[axis] += point[axis]!;
      count += 1;
    }
  }
  if (count < 12) return null;
  const mean: Point3 = [sums[0]! / count, sums[1]! / count, sums[2]! / count];
  for (const point of points) for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) squared[axis] += (point[axis]! - mean[axis]!) ** 2;
  for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) spreads[axis] = Math.sqrt(squared[axis]! / count);
  const axleAxis = (spreads[0]! <= spreads[1]! && spreads[0]! <= spreads[2]! ? 0 : spreads[1]! <= spreads[2]! ? 1 : 2) as 0 | 1 | 2;
  const planeAxes = ([0, 1, 2] as Array<0 | 1 | 2>).filter((axis) => axis !== axleAxis);
  const center: Point3 = [...component.bounds.center] as Point3;
  const radii: number[] = new Array(bins).fill(0);
  let radiusSum = 0;
  let samples = 0;
  const recordPoint = (u: number, v: number): void => {
    const radius = Math.hypot(u, v);
    if (radius <= 1e-9) return;
    const angle = Math.atan2(v, u);
    const bin = Math.floor((((angle + Math.PI) % (Math.PI * 2)) / (Math.PI * 2)) * bins) % bins;
    radii[bin] = Math.max(radii[bin]!, radius);
    radiusSum += radius;
    samples += 1;
  };
  // Densely sample projected triangle edges so coarse polygons still cover every angular bin.
  const samplesPerEdge = 16;
  for (const index of component.triangleIndices) {
    const triangle = sceneTriangleAt(snapshot, index);
    if (!triangle) continue;
    const projected = triangle.points.map((point) => [point[planeAxes[0]!]! - center[planeAxes[0]!]!, point[planeAxes[1]!]! - center[planeAxes[1]!]!] as [number, number]);
    for (let edge = 0; edge < 3; edge += 1) {
      const start = projected[edge]!;
      const end = projected[(edge + 1) % 3]!;
      for (let sample = 0; sample <= samplesPerEdge; sample += 1) {
        const t = sample / samplesPerEdge;
        recordPoint(start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t);
      }
    }
  }
  const occupied = radii.filter((radius) => radius > 0);
  const profileMean = samples ? radiusSum / samples : 0;
  const maxRadius = occupied.length ? Math.max(...occupied) : 0;
  const minRadius = occupied.length ? Math.min(...occupied) : 0;
  const radialRange = maxRadius > 0 ? (maxRadius - minRadius) / maxRadius : 1;
  return {
    center,
    axleAxis,
    axleAlignedWithX: axleAxis === 0,
    meanRadius: profileMean,
    radialRange,
    circumferenceCoverage: occupied.length / bins,
    sampleCount: samples,
  };
}

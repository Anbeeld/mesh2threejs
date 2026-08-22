import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import * as THREE from "three";
import type { CaptureCamera, CaptureFrame, CapturePass, Point3, RenderProfile, SceneSnapshot, SceneTriangle } from "../types.js";
import { canonicalJson, sha256 } from "./hashing.js";
import { forEachSceneTriangleReusable, selectSnapshotComponents } from "./geometry.js";
import { compareMasks } from "./measurement.js";

export interface CanonicalFrame {
  width: number;
  height: number;
  horizontalPixelsPerUnit: number;
  verticalPixelsPerUnit: number;
  orthographicHeight: number;
  minFeatureSize: number;
  cameras: Record<"side" | "front" | "plan" | "hero", CaptureCamera>;
  frameHash: string;
}

export function deriveCanonicalFrame(bounds: { min: Point3; max: Point3; size: Point3; center: Point3 }, minFeatureSize: number): CanonicalFrame {
  if (!(minFeatureSize > 0) || !Number.isFinite(minFeatureSize)) throw new Error("minimum feature size must be a positive object-unit value");
  const span = Math.max(...bounds.size, minFeatureSize);
  const orthographicHeight = Math.max(bounds.size[1], bounds.size[0], bounds.size[2]) * 1.15;
  const pixelsPerUnit = Math.max(8, Math.min(1536 / span, 2 / minFeatureSize));
  const resolution = Math.max(128, Math.min(768, Math.ceil(orthographicHeight * pixelsPerUnit / 16) * 16));
  const distance = span * 2.5 + 1;
  const [x, y, z] = bounds.center;
  const aspect = resolution / resolution;
  const payload = {
    width: resolution,
    height: resolution,
    horizontalPixelsPerUnit: (resolution - 1) / (orthographicHeight * aspect),
    verticalPixelsPerUnit: (resolution - 1) / orthographicHeight,
    orthographicHeight,
    minFeatureSize,
    cameras: {
      side: { id: "side", projection: "orthographic" as const, position: [x + distance, y, z] as const, target: [x, y, z] as const },
      front: { id: "front", projection: "orthographic" as const, position: [x, y, z + distance] as const, target: [x, y, z] as const },
      plan: { id: "plan", projection: "orthographic" as const, position: [x, y + distance, z] as const, target: [x, y, z] as const },
      hero: { id: "hero", projection: "perspective" as const, position: [x + distance * 0.7, y + distance * 0.35, z + distance * 0.7] as const, target: [x, y, z] as const },
    },
  };
  return { ...payload, frameHash: sha256(canonicalJson(payload)) };
}

const STANDARD_PASSES: CapturePass[] = [
  "beauty",
  "alpha-silhouette",
  "semantic-id",
  "depth",
  "normal",
  "roughness-material-id",
];

export function standardRenderProfile(options: { width?: number; height?: number } = {}): RenderProfile {
  return {
    schemaVersion: "render-profile.v1",
    renderer: {
      backend: "deterministic-cpu",
      colorManagement: "linear-srgb-to-srgb",
      toneMapping: "neutral",
      exposure: 1,
      width: options.width ?? 256,
      height: options.height ?? 256,
      devicePixelRatio: 1,
      antialias: false,
    },
    background: [21, 27, 32, 255],
    environment: { kind: "fixed-directional", intensity: 1 },
    camera: { near: 0.01, far: 200, orthographicHeight: 10, perspectiveFov: 35 },
    passes: [...STANDARD_PASSES],
  };
}

interface ProjectedPoint {
  x: number;
  y: number;
  depth: number;
  valid: boolean;
}

function cameraBasis(camera: CaptureCamera): { position: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3; forward: THREE.Vector3 } {
  const position = new THREE.Vector3(...camera.position);
  const target = new THREE.Vector3(...camera.target);
  const forward = target.sub(position).normalize();
  const referenceUp = Math.abs(forward.dot(new THREE.Vector3(0, 1, 0))) > 0.99
    ? new THREE.Vector3(0, 0, 1)
    : new THREE.Vector3(0, 1, 0);
  const right = forward.clone().cross(referenceUp).normalize();
  const up = right.clone().cross(forward).normalize();
  return { position, right, up, forward };
}

function projectInto(point: Point3, profile: RenderProfile, camera: CaptureCamera, basis: ReturnType<typeof cameraBasis>, output: ProjectedPoint): void {
  const rx = point[0] - basis.position.x; const ry = point[1] - basis.position.y; const rz = point[2] - basis.position.z;
  const x = rx * basis.right.x + ry * basis.right.y + rz * basis.right.z;
  const y = rx * basis.up.x + ry * basis.up.y + rz * basis.up.z;
  const depth = rx * basis.forward.x + ry * basis.forward.y + rz * basis.forward.z;
  const aspect = profile.renderer.width / profile.renderer.height;
  let ndcX: number;
  let ndcY: number;
  if (camera.projection === "perspective") {
    const halfY = Math.tan((profile.camera.perspectiveFov * Math.PI) / 360) * depth;
    ndcX = x / (halfY * aspect);
    ndcY = y / halfY;
  } else {
    ndcX = x / ((profile.camera.orthographicHeight * aspect) / 2);
    ndcY = y / (profile.camera.orthographicHeight / 2);
  }
  output.x = (ndcX * 0.5 + 0.5) * (profile.renderer.width - 1);
  output.y = (0.5 - ndcY * 0.5) * (profile.renderer.height - 1);
  output.depth = depth;
  output.valid = depth >= profile.camera.near && depth <= profile.camera.far && Number.isFinite(ndcX) && Number.isFinite(ndcY);
}

function hashColor(value: string): [number, number, number] {
  const digest = sha256(value);
  return [
    48 + (Number.parseInt(digest.slice(0, 2), 16) % 192),
    48 + (Number.parseInt(digest.slice(2, 4), 16) % 192),
    48 + (Number.parseInt(digest.slice(4, 6), 16) % 192),
  ];
}

function hexColor(value: number): [number, number, number] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function srgbChannel(linearByte: number): number {
  const linear = Math.max(0, Math.min(1, linearByte / 255));
  const srgb = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, srgb)) * 255);
}

function triangleColor(triangle: SceneTriangle, pass: CapturePass, depth: number, profile: RenderProfile): [number, number, number, number] {
  switch (pass) {
    case "alpha-silhouette":
      return [255, 255, 255, 255];
    case "semantic-id": {
      const [r, g, b] = hashColor(triangle.componentId);
      return [r, g, b, 255];
    }
    case "depth": {
      const normalized = Math.max(0, Math.min(1, (depth - profile.camera.near) / (profile.camera.far - profile.camera.near)));
      const value = Math.round((1 - normalized) * 255);
      return [value, value, value, 255];
    }
    case "normal":
      return [
        Math.round((triangle.normal[0] * 0.5 + 0.5) * 255),
        Math.round((triangle.normal[1] * 0.5 + 0.5) * 255),
        Math.round((triangle.normal[2] * 0.5 + 0.5) * 255),
        255,
      ];
    case "roughness-material-id": {
      const [, g, b] = hashColor(triangle.materialId);
      return [Math.round(Math.max(0, Math.min(1, triangle.roughness)) * 255), g, b, 255];
    }
    case "beauty": {
      const [r, g, b] = hexColor(triangle.color);
      const light = new THREE.Vector3(0.35, 0.8, 0.48).normalize();
      const normal = new THREE.Vector3(...triangle.normal);
      const intensity = 0.28 + 0.72 * Math.max(0, normal.dot(light)) * profile.environment.intensity;
      return [
        srgbChannel(r * intensity * profile.renderer.exposure),
        srgbChannel(g * intensity * profile.renderer.exposure),
        srgbChannel(b * intensity * profile.renderer.exposure),
        255,
      ];
    }
  }
}

function edge(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

export function rasterizeCapture(snapshot: SceneSnapshot, profile: RenderProfile, camera: CaptureCamera, pass: CapturePass): CaptureFrame {
  if (!profile.passes.includes(pass)) throw new Error(`capture pass is not enabled: ${pass}`);
  const { width, height } = profile.renderer;
  const data = new Uint8Array(width * height * 4);
  const background = pass === "alpha-silhouette" ? [0, 0, 0, 0] : profile.background;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    data.set(background, pixel * 4);
  }
  const zbuffer = new Float64Array(width * height);
  zbuffer.fill(Number.POSITIVE_INFINITY);
  const basis = cameraBasis(camera);

  const projected: [ProjectedPoint, ProjectedPoint, ProjectedPoint] = [{ x: 0, y: 0, depth: 0, valid: false }, { x: 0, y: 0, depth: 0, valid: false }, { x: 0, y: 0, depth: 0, valid: false }];
  forEachSceneTriangleReusable(snapshot, (triangle) => {
    projectInto(triangle.points[0], profile, camera, basis, projected[0]); projectInto(triangle.points[1], profile, camera, basis, projected[1]); projectInto(triangle.points[2], profile, camera, basis, projected[2]);
    if (!projected.every((point) => point.valid)) return;
    const [a, b, c] = projected;
    const area = edge(a.x, a.y, b.x, b.y, c.x, c.y);
    if (Math.abs(area) < 1e-12) return;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = edge(b.x, b.y, c.x, c.y, px, py) / area;
        const w1 = edge(c.x, c.y, a.x, a.y, px, py) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
        const depth = w0 * a.depth + w1 * b.depth + w2 * c.depth;
        const offset = y * width + x;
        if (depth >= (zbuffer[offset] ?? Number.POSITIVE_INFINITY)) continue;
        zbuffer[offset] = depth;
        data.set(triangleColor(triangle, pass, depth, profile), offset * 4);
      }
    }
  });
  return {
    pass,
    cameraId: camera.id,
    width,
    height,
    data,
    profileHash: sha256(canonicalJson(profile)),
  };
}

export async function writeCapturePng(path: string, frame: CaptureFrame): Promise<void> {
  const png = new PNG({ width: frame.width, height: frame.height });
  png.data = Buffer.from(frame.data);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, PNG.sync.write(png));
}

export async function createComparisonBoard(path: string, oracle: CaptureFrame, candidate: CaptureFrame): Promise<{ path: string; width: number; height: number }> {
  if (oracle.height !== candidate.height || oracle.pass !== candidate.pass) throw new Error("comparison frames are incompatible");
  const width = oracle.width + candidate.width;
  const height = oracle.height;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const leftStart = y * oracle.width * 4;
    const rightStart = y * candidate.width * 4;
    data.set(oracle.data.subarray(leftStart, leftStart + oracle.width * 4), y * width * 4);
    data.set(candidate.data.subarray(rightStart, rightStart + candidate.width * 4), (y * width + oracle.width) * 4);
  }
  await writeCapturePng(path, { ...oracle, width, height, data, cameraId: `${oracle.cameraId}-comparison` });
  return { path, width, height };
}

export async function createTurntable(
  directory: string,
  snapshot: SceneSnapshot,
  profile: RenderProfile,
  options: { frames?: number; radius?: number; elevation?: number; target?: Point3 } = {},
): Promise<string[]> {
  const frames = options.frames ?? 24;
  const radius = options.radius ?? 12;
  const elevation = options.elevation ?? 4;
  const target = options.target ?? [0, 0, 0];
  await mkdir(directory, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < frames; index += 1) {
    const angle = (index / frames) * Math.PI * 2;
    const camera: CaptureCamera = {
      id: `turntable-${String(index).padStart(3, "0")}`,
      projection: "perspective",
      position: [target[0] + Math.sin(angle) * radius, target[1] + elevation, target[2] + Math.cos(angle) * radius],
      target,
    };
    const frame = rasterizeCapture(snapshot, profile, camera, "beauty");
    const path = join(directory, `${camera.id}.png`);
    await writeCapturePng(path, frame);
    paths.push(path);
  }
  return paths;
}

export interface RegionDiagnostic {
  semanticId: string;
  view: string;
  silhouetteIou: number;
  missingRatio: number;
  excessRatio: number;
  depthMae: number;
  normalMae: number;
  materialMae: number;
}

function frameMae(oracle: CaptureFrame, candidate: CaptureFrame, oracleMask: CaptureFrame, candidateMask: CaptureFrame): number {
  let total = 0; let samples = 0;
  for (let pixel = 0; pixel < oracle.width * oracle.height; pixel += 1) {
    if ((oracleMask.data[pixel * 4 + 3] ?? 0) === 0 && (candidateMask.data[pixel * 4 + 3] ?? 0) === 0) continue;
    for (let channel = 0; channel < 3; channel += 1) total += Math.abs((oracle.data[pixel * 4 + channel] ?? 0) - (candidate.data[pixel * 4 + channel] ?? 0)) / 255;
    samples += 3;
  }
  return samples ? total / samples : 0;
}

export function compareRegionDiagnostics(oracle: SceneSnapshot, candidate: SceneSnapshot, profile: RenderProfile, cameras: CaptureCamera[]): RegionDiagnostic[] {
  const ids = [...new Set([...Object.keys(oracle.components), ...Object.keys(candidate.components)])].sort();
  const diagnostics: RegionDiagnostic[] = [];
  for (const semanticId of ids) {
    const oracleRegion = selectSnapshotComponents(oracle, (component) => component.id === semanticId);
    const candidateRegion = selectSnapshotComponents(candidate, (component) => component.id === semanticId);
    for (const camera of cameras) {
      const oracleMask = rasterizeCapture(oracleRegion, profile, camera, "alpha-silhouette");
      const candidateMask = rasterizeCapture(candidateRegion, profile, camera, "alpha-silhouette");
      const masks = compareMasks(oracleMask, candidateMask);
      const pair = (pass: "depth" | "normal" | "roughness-material-id"): number => frameMae(rasterizeCapture(oracleRegion, profile, camera, pass), rasterizeCapture(candidateRegion, profile, camera, pass), oracleMask, candidateMask);
      diagnostics.push({ semanticId, view: camera.id, silhouetteIou: masks.iou, missingRatio: masks.missingRatio, excessRatio: masks.excessRatio, depthMae: pair("depth"), normalMae: pair("normal"), materialMae: pair("roughness-material-id") });
    }
  }
  return diagnostics;
}

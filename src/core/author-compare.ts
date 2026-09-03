import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as THREE from "three";
import { PNG } from "pngjs";
import { canonicalJson, sha256 } from "./hashing.js";
import { snapshotScene } from "./geometry.js";
import { measureBounds } from "./measurement.js";
import { deriveCanonicalFrame, standardRenderProfile, writeCapturePng, type CanonicalFrame } from "./render.js";
import { renderCapture } from "./three-render.js";
import type { CaptureFrame, Point3 } from "../types.js";

/**
 * Stylized comparison surface (minimal Bundle F, design §12/§18.1/§40): ONE supported
 * operation that produces, for side / front / rear / plan / front-3/4 views:
 *
 *   Oracle | Candidate | Style-reference   triplet boards, plus
 *   oracle ghost overlays (oracle silhouette at 50% over the candidate beauty render).
 *
 * The entire motivation for the stylized-authored mode is that agents kept satisfying math
 * while failing to actually LOOK at the art. This surface makes looking at the art a
 * first-class trusted operation rather than deferred viewer work.
 */

export interface StyleReferenceInput {
  label: string;
  /** Absolute path of the style image (registered style reference). */
  path: string;
  /** Declared vehicle view of the reference (side/front/rear/plan/front-3-4/rear-3-4/overview), when declared. */
  view?: string;
  role: string;
  /** Raw file bytes; PNG-decodable files are composable into boards. */
  bytes: Buffer;
  png: boolean;
}

export type StyleMatchKind = "exact-view" | "general" | "contact-sheet";

/**
 * View-aware style resolution (lifecycle closure): for each comparison view pick
 * 1. a reference that DECLARES that view (primary-style before style-family before other);
 * 2. otherwise a general (view-less) primary-style reference;
 * 3. otherwise the contact sheet — MULTIPLE references tiled, so the board never pretends
 *    one image is a corresponding view.
 * Only PNG-decodable references are composable; the caller supplies the composable set.
 */
export function resolveStyleForView(
  references: ReadonlyArray<StyleReferenceInput & { png: boolean }>,
  view: string,
): { reference: StyleReferenceInput | null; match: StyleMatchKind } {
  const withView = references.filter((reference) => reference.png && reference.view === view);
  if (withView.length) {
    const primary = withView.find((reference) => reference.role === "primary-style") ?? withView.find((reference) => reference.role === "style-family") ?? withView[0]!;
    return { reference: primary, match: "exact-view" };
  }
  const general = references.filter((reference) => reference.png && !reference.view);
  if (general.length) {
    const primary = general.find((reference) => reference.role === "primary-style") ?? general.find((reference) => reference.role === "style-family") ?? general[0]!;
    return { reference: primary, match: "general" };
  }
  return { reference: null, match: "contact-sheet" };
}

export interface AuthorCompareBoard {
  path: string;
  sha256: string;
  kind: "style-triplet" | "style-triplet-contact-sheet" | "ghost-overlay";
  view: string;
}

export interface AuthorCompareResult {
  directory: string;
  view: string;
  boards: AuthorCompareBoard[];
  ghostOverlays: AuthorCompareBoard[];
  manifestPath: string;
  manifestHash: string;
  views: string[];
}

const COMPARISON_VIEWS = ["side", "front", "rear", "plan", "front-3-4"] as const;
const GHOST_VIEWS = ["side", "front", "plan"] as const;

/**
 * Comparison cameras. REAR mirrors the FRONT camera through the target (front looks along
 * +Z in the canonical frame, so rear looks from -Z), NOT the mirrored side camera — the
 * side view is +X, and "-X" would just be the opposite SIDE of the vehicle, not the rear.
 * Regression-tested: rear.position === 2*target - front.position.
 */
export function comparisonCameras(frame: CanonicalFrame): Record<string, import("../types.js").CaptureCamera> {
  const [tx, ty, tz] = frame.cameras.side.target as Point3;
  const [fx, fy, fz] = frame.cameras.front.position as Point3;
  const [sx, sy, sz] = frame.cameras.side.position as Point3;
  const distance = Math.abs(sx - tx);
  return {
    side: frame.cameras.side,
    front: frame.cameras.front,
    rear: {
      id: "rear",
      projection: "orthographic",
      position: [fx - 2 * (fx - tx), fy - 2 * (fy - ty), fz - 2 * (fz - tz)] as const,
      target: [tx, ty, tz] as const,
    },
    plan: frame.cameras.plan,
    "front-3-4": { id: "front-3-4", projection: "perspective", position: [sx + distance * 0.35, sy + distance * 0.35, sz + distance * 0.6] as const, target: [tx, ty, tz] as const },
  };
}

export const COMPARISON_VIEW_IDS = ["side", "front", "rear", "plan", "front-3-4"] as const;
export type ComparisonView = (typeof COMPARISON_VIEW_IDS)[number];

/** Loads a style PNG and rescales it (nearest neighbor) to the given frame height. */
function styleFrame(pngBytes: Buffer, width: number, height: number): { data: Uint8Array; width: number; height: number } {
  const source = PNG.sync.read(pngBytes);
  const scale = height / source.height;
  const scaledWidth = Math.max(1, Math.round(source.width * scale));
  const data = new Uint8Array(scaledWidth * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor(y / scale));
    for (let x = 0; x < scaledWidth; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor(x / scale));
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (y * scaledWidth + x) * 4;
      data[targetOffset] = source.data[sourceOffset]!;
      data[targetOffset + 1] = source.data[sourceOffset + 1]!;
      data[targetOffset + 2] = source.data[sourceOffset + 2]!;
      data[targetOffset + 3] = 255;
    }
  }
  void width;
  return { data, width: scaledWidth, height };
}

/**
 * Oracle | Candidate | Style triplet: three columns, same row alignment, so the reviewer
 * sees the geometry authorities and the art authority side by side in one image. When
 * several style images are supplied (contact-sheet fallback) they are tiled VERTICALLY in
 * the third column so the reviewer sees multiple references instead of one misleading frame.
 */
export async function createStyleComparisonBoard(
  path: string,
  oracle: CaptureFrame,
  candidate: CaptureFrame,
  stylePngs: ReadonlyArray<Buffer>,
  styleLabel: string,
): Promise<{ path: string; width: number; height: number; contactSheet: boolean }> {
  if (oracle.height !== candidate.height || oracle.pass !== candidate.pass) throw new Error("comparison frames are incompatible");
  void styleLabel;
  const images = stylePngs.slice(0, 4).map((png) => styleFrame(png, oracle.width, oracle.height));
  const contactSheet = images.length > 1;
  const styleWidth = Math.max(...images.map((image) => image.width));
  const styleData = new Uint8Array(styleDataFor(images, styleWidth, oracle.height));
  const width = oracle.width + candidate.width + styleWidth;
  const height = oracle.height;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    data.set(oracle.data.subarray(y * oracle.width * 4, (y + 1) * oracle.width * 4), y * width * 4);
    data.set(candidate.data.subarray(y * candidate.width * 4, (y + 1) * candidate.width * 4), (y * width + oracle.width) * 4);
    data.set(styleData.subarray(y * styleWidth * 4, (y + 1) * styleWidth * 4), (y * width + oracle.width + candidate.width) * 4);
  }
  await writeCapturePng(path, { ...oracle, width, height, data, cameraId: `${oracle.cameraId}-style-comparison` });
  return { path, width, height, contactSheet };
}

/** Tiles style frames vertically into one column of the given width. */
function styleDataFor(images: ReadonlyArray<{ data: Uint8Array; width: number; height: number }>, columnWidth: number, boardHeight: number): Uint8Array {
  const column = new Uint8Array(columnWidth * boardHeight * 4);
  const sliceHeight = Math.floor(boardHeight / images.length);
  let painted = 0;
  for (const [index, image] of images.entries()) {
    const scale = sliceHeight / image.height;
    const scaledWidth = Math.max(1, Math.round(image.width * scale));
    const targetY = index * sliceHeight;
    for (let y = 0; y < sliceHeight; y += 1) {
      const sourceY = Math.min(image.height - 1, Math.floor(y / scale));
      const copyWidth = Math.min(scaledWidth, columnWidth);
      for (let x = 0; x < copyWidth; x += 1) {
        const sourceX = Math.min(image.width - 1, Math.floor(x / scale));
        const sourceOffset = (sourceY * image.width + sourceX) * 4;
        const targetOffset = ((targetY + y) * columnWidth + x) * 4;
        column[targetOffset] = image.data[sourceOffset]!;
        column[targetOffset + 1] = image.data[sourceOffset + 1]!;
        column[targetOffset + 2] = image.data[sourceOffset + 2]!;
        column[targetOffset + 3] = 255;
      }
      void sourceY;
    }
    painted += 1;
  }
  void painted;
  return column;
}

/** Oracle ghost overlay: the oracle alpha-silhouette at 50% over the candidate beauty render. */
export async function createGhostOverlayBoard(path: string, oracleSilhouette: CaptureFrame, candidateBeauty: CaptureFrame): Promise<{ path: string; width: number; height: number }> {
  if (oracleSilhouette.width !== candidateBeauty.width || oracleSilhouette.height !== candidateBeauty.height) {
    throw new Error("ghost overlay frames must share the canonical resolution");
  }
  const size = oracleSilhouette.width * oracleSilhouette.height;
  const data = new Uint8Array(candidateBeauty.data);
  for (let index = 0; index < size; index += 1) {
    const offset = index * 4;
    const oracleAlpha = oracleSilhouette.data[offset + 3]! / 255;
    if (oracleAlpha <= 0) continue;
    // 50% ghost: blend the oracle silhouette color over the candidate render.
    for (let channel = 0; channel < 3; channel += 1) {
      data[offset + channel] = Math.round((oracleSilhouette.data[offset + channel]! * 0.5 + candidateBeauty.data[offset + channel]! * 0.5));
    }
  }
  await writeCapturePng(path, { ...candidateBeauty, data, cameraId: `${candidateBeauty.cameraId}-ghost` });
  return { path, width: candidateBeauty.width, height: candidateBeauty.height };
}


export interface AuthorCompareRunInput {
  directory: string;
  oracle: THREE.Object3D;
  candidate: THREE.Object3D;
  styleReferences: ReadonlyArray<StyleReferenceInput>;
  runId: string;
  backend?: "auto" | "deterministic-cpu" | "three-webgl";
}

export interface AuthorCompareRunResult {
  directory: string;
  views: string[];
  boards: AuthorCompareBoard[];
  ghostOverlays: AuthorCompareBoard[];
  manifestPath: string;
  manifestHash: string;
}

/**
 * Runs the full comparison capture set: five triplet boards (Oracle | Candidate | Style)
 * plus three oracle ghost overlays, with a hashed manifest. Diagnostic evidence for the
 * authoring loop — never certification evidence.
 */
export async function performAuthorCompareRun(input: AuthorCompareRunInput): Promise<AuthorCompareRunResult> {
  const { renderCapture } = await import("./three-render.js");
  const oracleSnapshot = snapshotScene(input.oracle);
  const candidateSnapshot = snapshotScene(input.candidate);
  const { measureBounds } = await import("./measurement.js");
  const oracleBounds = measureBounds(oracleSnapshot);
  const frame = deriveCanonicalFrame(oracleBounds, 0.01);
  const profile = standardRenderProfile({ width: frame.width, height: frame.height });
  profile.camera.orthographicHeight = frame.orthographicHeight;
  profile.camera.far = Math.max(profile.camera.far, frame.orthographicHeight * 4);
  await mkdir(input.directory, { recursive: true });
  if (!input.styleReferences.length) throw new Error("author-compare requires at least one registered style reference");
  const composable = input.styleReferences.filter((reference) => reference.png);
  if (!composable.length) throw new Error("author-compare requires at least one PNG-decodable style reference for board composition; register a PNG style image");
  const cameras = comparisonCameras(frame);
  const boards: AuthorCompareBoard[] = [];
  const ghostOverlays: AuthorCompareBoard[] = [];
  const styleSelection: Array<{ view: string; match: string; referencePath: string | null }> = [];
  for (const view of COMPARISON_VIEWS) {
    const camera = cameras[view]!;
    const oracleFrame = renderCapture({ root: input.oracle, snapshot: oracleSnapshot, profile, camera, pass: "beauty", backend: input.backend ?? "deterministic-cpu" }).frame;
    const candidateFrame = renderCapture({ root: input.candidate, snapshot: candidateSnapshot, profile, camera, pass: "beauty", backend: input.backend === "three-webgl" ? "three-webgl" : "deterministic-cpu" }).frame;
    const selection = resolveStyleForView(composable, view);
    const stylePngs = selection.match === "contact-sheet"
      ? composable.slice(0, 4).map((reference) => reference.bytes)
      : [selection.reference!.bytes];
    const boardPath = join(input.directory, `${view}-oracle-candidate-style.png`);
    const composed = await createStyleComparisonBoard(boardPath, oracleFrame, candidateFrame, stylePngs, selection.reference?.label ?? "contact-sheet");
    styleSelection.push({ view, match: selection.match, referencePath: selection.reference?.path ?? null });
    boards.push({ path: boardPath, sha256: sha256(await readFile(boardPath)), kind: composed.contactSheet ? "style-triplet-contact-sheet" : "style-triplet", view });
    if ((GHOST_VIEWS as readonly string[]).includes(view)) {
      const oracleSilhouette = renderCapture({ root: input.oracle, snapshot: oracleSnapshot, profile, camera, pass: "alpha-silhouette", backend: input.backend === "three-webgl" ? "three-webgl" : "deterministic-cpu" }).frame;
      const overlayPath = join(input.directory, `${view}-oracle-ghost-overlay.png`);
      await createGhostOverlayBoard(overlayPath, oracleSilhouette, candidateFrame);
      ghostOverlays.push({ path: overlayPath, sha256: sha256(await readFile(overlayPath)), kind: "ghost-overlay", view });
    }
  }
  const manifest = {
    schemaVersion: 2,
    kind: "mesh2threejs-author-compare",
    runId: input.runId,
    views: [...COMPARISON_VIEWS],
    ghostViews: [...GHOST_VIEWS],
    styleReferences: input.styleReferences.map((reference) => ({ path: reference.path, label: reference.label, view: reference.view ?? null, role: reference.role })),
    styleSelection,
    boards,
    ghostOverlays,
  };
  const manifestPath = join(input.directory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return {
    directory: input.directory,
    views: [...COMPARISON_VIEWS],
    boards,
    ghostOverlays,
    manifestPath,
    manifestHash: sha256(canonicalJson(manifest)),
  };
}
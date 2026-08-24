import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OracleManifest } from "./oracle.js";
import type { CandidateIdentity } from "./candidate.js";
import type { ResumedWorkspace } from "./workspace.js";
import { createWorkspaceResolver } from "./workspace.js";
import { fingerprintScene, canonicalJson, sha256 } from "./hashing.js";
import { snapshotScene } from "./geometry.js";
import { measureBounds } from "./measurement.js";
import { compareRegionDiagnostics, createComparisonBoard, createTurntable, deriveCanonicalFrame, standardRenderProfile, writeCapturePng } from "./render.js";
import { renderCapture, type RenderBackend } from "./three-render.js";
import { bindEvidenceConfig, createRenderEvidenceArtifact, loadTaskState, recordEvidenceArtifact, saveTaskState } from "./state.js";
import type { CaptureCamera, CapturePass } from "../types.js";

export interface RenderManifestCapture {
  subject: "oracle" | "candidate";
  pass: CapturePass;
  cameraId: string;
  path: string;
  sha256: string;
}

export interface HashedArtifactPath {
  path: string;
  sha256: string;
}

export interface WorkspaceRenderManifest {
  schemaVersion: 1;
  kind: string;
  backend: "deterministic-cpu" | "three-webgl";
  oracleHash: string;
  candidateHash: string;
  styleContractHash: string;
  evaluationIdentityHash: string;
  frame: ReturnType<typeof deriveCanonicalFrame>;
  profileHash: string;
  captures: RenderManifestCapture[];
  comparisonBoards: HashedArtifactPath[];
  turntable: HashedArtifactPath[];
  regionDiagnostics: HashedArtifactPath;
}

export interface PerformRenderRunOptions {
  /** When present, the run is bound to the live workspace state and emits turntable evidence. */
  workspace?: ResumedWorkspace;
  manifest: OracleManifest;
  /** Only the trusted candidate hash participates in render evidence binding. */
  candidateIdentity: Pick<CandidateIdentity, "candidateHash">;
  candidate: import("three").Object3D;
  oracle: import("three").Object3D;
  /** Absolute output directory; created when missing. */
  directory: string;
  /** Workspace run identifier (e.g. render-0007); required together with `workspace`. */
  runId?: string;
  backend?: string;
  precision?: number;
}

export interface RenderRunResult {
  backend: "deterministic-cpu" | "three-webgl";
  manifest: WorkspaceRenderManifest;
  manifestPath: string;
  directory: string;
  runId?: string;
  comparisonBoards: HashedArtifactPath[];
  turntable: HashedArtifactPath[];
  regionDiagnostics: HashedArtifactPath;
  captureCount: number;
}

/**
 * Executes one full capture run (six diagnostic passes across side/front/plan, comparison
 * boards, turntable, region diagnostics, render manifest) against the prepared oracle and
 * the current candidate. Shared by `render` and `review-ready` so user-review handoffs
 * never reinvent the capture pipeline. Workspace runs also bind turntable evidence to state.
 */
export async function performRenderRun(options: PerformRenderRunOptions): Promise<RenderRunResult> {
  const { workspace, candidateIdentity, candidate, oracle, directory } = options;
  const requestedBackend = (options.backend ?? "auto") as RenderBackend;
  if (!["auto", "deterministic-cpu", "three-webgl"].includes(requestedBackend)) throw new Error("--renderer must be auto, deterministic-cpu, or three-webgl");
  if (workspace && !options.runId) throw new Error("workspace render runs require a run identifier");
  const toStoredPath = (path: string): string => {
    if (!workspace) return path;
    return createWorkspaceResolver(workspace.root).toProjectPath(path);
  };
  const oracleSnapshot = snapshotScene(oracle);
  const candidateSnapshot = snapshotScene(candidate);
  const oracleBounds = measureBounds(oracleSnapshot);
  const frame = deriveCanonicalFrame(oracleBounds, Number(options.precision ?? 0.01));
  const profile = standardRenderProfile({ width: frame.width, height: frame.height });
  profile.camera.orthographicHeight = frame.orthographicHeight;
  profile.camera.far = Math.max(profile.camera.far, frame.orthographicHeight * 4);
  await mkdir(directory, { recursive: true });
  const passes: CapturePass[] = ["beauty", "alpha-silhouette", "semantic-id", "depth", "normal", "roughness-material-id"];
  const captures: RenderManifestCapture[] = [];
  const boards: string[] = [];
  for (const cameraId of ["side", "front", "plan"] as const) {
    for (const pass of passes) {
      const oracleRendered = renderCapture({ root: oracle, snapshot: oracleSnapshot, profile, camera: frame.cameras[cameraId], pass, backend: requestedBackend });
      const candidateRendered = renderCapture({ root: candidate, snapshot: candidateSnapshot, profile, camera: frame.cameras[cameraId], pass, backend: requestedBackend });
      const oracleFrame = oracleRendered.frame;
      const candidateFrame = candidateRendered.frame;
      const oraclePath = join(directory, `${cameraId}-oracle-${pass}.png`);
      const candidatePath = join(directory, `${cameraId}-candidate-${pass}.png`);
      await writeCapturePng(oraclePath, oracleFrame);
      await writeCapturePng(candidatePath, candidateFrame);
      captures.push(
        { subject: "oracle", pass, cameraId, path: toStoredPath(oraclePath), sha256: sha256(await readFile(oraclePath)) },
        { subject: "candidate", pass, cameraId, path: toStoredPath(candidatePath), sha256: sha256(await readFile(candidatePath)) },
      );
      if (pass === "beauty") {
        const board = join(directory, `${cameraId}-comparison.png`);
        await createComparisonBoard(board, oracleFrame, candidateFrame);
        boards.push(board);
      }
    }
  }
  const span = Math.max(...oracleBounds.size);
  const turntablePaths = await createTurntable(join(directory, "turntable"), candidateSnapshot, profile, { frames: 24, radius: span * 2.5, elevation: Math.max(span * 0.35, oracleBounds.size[1] * 0.75), target: oracleBounds.center });
  const regionDiagnosticsPath = join(directory, "region-diagnostics.json");
  await writeFile(regionDiagnosticsPath, `${JSON.stringify({ schemaVersion: 1, rows: compareRegionDiagnostics(oracleSnapshot, candidateSnapshot, profile, [frame.cameras.side, frame.cameras.front, frame.cameras.plan]) }, null, 2)}\n`, { flag: "wx" });
  const regionDiagnostics = { path: toStoredPath(regionDiagnosticsPath), sha256: sha256(await readFile(regionDiagnosticsPath)) };
  const actualBackend: RenderRunResult["backend"] = requestedBackend === "three-webgl" ? "three-webgl" : "deterministic-cpu";
  const comparisonBoards = await Promise.all(boards.map(async (path) => ({ path: toStoredPath(path), sha256: sha256(await readFile(path)) })));
  const turntable = await Promise.all(turntablePaths.map(async (path) => ({ path: toStoredPath(path), sha256: sha256(await readFile(path)) })));
  const manifest: WorkspaceRenderManifest = {
    schemaVersion: 1,
    kind: `${actualBackend}-render-evidence`,
    backend: actualBackend,
    oracleHash: fingerprintScene(oracle),
    candidateHash: candidateIdentity.candidateHash,
    styleContractHash: workspace?.state.styleContractHash ?? "unbound",
    evaluationIdentityHash: workspace?.state.evaluationIdentityHash ?? "unbound",
    frame,
    profileHash: sha256(canonicalJson(profile)),
    captures,
    comparisonBoards,
    turntable,
    regionDiagnostics,
  };
  const manifestPath = join(directory, "render-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  if (workspace && options.runId) {
    let state = await loadTaskState(workspace.layout.internal.state);
    if (state.oracleHash !== manifest.oracleHash || state.candidateHash !== manifest.candidateHash) throw new Error("render evidence is bound to geometry that has not passed the current gate run");
    const evidenceDirectory = join(workspace.layout.internal.evidence, options.runId);
    await mkdir(evidenceDirectory);
    const configHash = sha256(canonicalJson({ frame: frame.frameHash, profile: manifest.profileHash, backend: actualBackend }));
    state = bindEvidenceConfig(state, "turntable", configHash, "render frame or backend changed");
    const artifact = createRenderEvidenceArtifact({ id: `${options.runId}-turntable`, phase: "visual-review", oracleHash: manifest.oracleHash, candidateHash: manifest.candidateHash, profileContractHash: state.profileContractHash, styleContractHash: state.styleContractHash, evaluationIdentityHash: state.evaluationIdentityHash, configHash, manifest: { ...manifest } });
    const artifactPath = join(evidenceDirectory, "turntable.json");
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    state = recordEvidenceArtifact(state, toStoredPath(artifactPath), artifact);
    await saveTaskState(workspace.layout.internal.state, state);
  }
  return {
    backend: actualBackend,
    manifest,
    manifestPath,
    directory,
    ...(options.runId ? { runId: options.runId } : {}),
    comparisonBoards,
    turntable,
    regionDiagnostics,
    captureCount: captures.length,
  };
}

export interface QuickDiagnosticResult {
  backend: "deterministic-cpu" | "three-webgl";
  directory: string;
  manifestPath: string;
  boards: HashedArtifactPath[];
  captures: number;
}

/**
 * Cheap agent-side sanity captures for the ACTIVE phase: one side comparison, one front
 * comparison, and one perspective comparison, beauty pass only. This is a builder diagnostic
 * surface — it never records visual-review evidence, never emits a turntable, and its run
 * directories are deliberately invisible to user-review packet assembly (`quick-*` vs `render-*`).
 */
export async function performQuickDiagnosticRun(workspace: ResumedWorkspace, manifest: OracleManifest, oracle: import("three").Object3D, candidateIdentity: Pick<CandidateIdentity, "candidateHash">, candidate: import("three").Object3D, backend: RenderBackend = "deterministic-cpu"): Promise<QuickDiagnosticResult> {
  const directory = await createPrefixedRunDirectory(workspace.layout.internal.captures, "quick");
  const oracleSnapshot = snapshotScene(oracle);
  const candidateSnapshot = snapshotScene(candidate);
  const bounds = measureBounds(oracleSnapshot);
  const frame = deriveCanonicalFrame(bounds, 0.01);
  const profile = standardRenderProfile({ width: frame.width, height: frame.height });
  profile.camera.orthographicHeight = frame.orthographicHeight;
  profile.camera.far = Math.max(profile.camera.far, frame.orthographicHeight * 4);
  await mkdir(directory, { recursive: true });
  const span = Math.max(...bounds.size);
  const [x, y, z] = bounds.center;
  const distance = span * 2.5 + 1;
  const perspective: CaptureCamera = { id: "perspective", projection: "perspective", position: [x - distance * 0.7, y + distance * 0.35, z - distance * 0.7] as const, target: [x, y, z] as const };
  const views: Array<{ id: string; camera: CaptureCamera }> = [
    { id: "side", camera: frame.cameras.side },
    { id: "front", camera: frame.cameras.front },
    { id: "perspective", camera: perspective },
  ];
  let captures = 0;
  const boards: HashedArtifactPath[] = [];
  for (const view of views) {
    const oracleFrame = renderCapture({ root: oracle, snapshot: oracleSnapshot, profile, camera: view.camera, pass: "beauty", backend }).frame;
    const candidateFrame = renderCapture({ root: candidate, snapshot: candidateSnapshot, profile, camera: view.camera, pass: "beauty", backend }).frame;
    const oraclePath = join(directory, `${view.id}-oracle-beauty.png`);
    const candidatePath = join(directory, `${view.id}-candidate-beauty.png`);
    await writeCapturePng(oraclePath, oracleFrame);
    await writeCapturePng(candidatePath, candidateFrame);
    captures += 2;
    const board = join(directory, `${view.id}-comparison.png`);
    await createComparisonBoard(board, oracleFrame, candidateFrame);
    boards.push({ path: board, sha256: sha256(await readFile(board)) });
  }
  const manifestPayload = {
    schemaVersion: 1,
    kind: "quick-agent-diagnostic",
    builderDiagnosticOnly: true,
    backend,
    oracleHash: fingerprintScene(oracle),
    candidateHash: candidateIdentity.candidateHash,
    views: views.map((view) => view.id),
    boards: boards.map((board) => ({ path: board.path, sha256: board.sha256 })),
  };
  const manifestPath = join(directory, "quick-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifestPayload, null, 2)}\n`, { flag: "wx" });
  return { backend: backend === "three-webgl" ? "three-webgl" : "deterministic-cpu", directory, manifestPath, boards, captures };
}

async function createPrefixedRunDirectory(parent: string, prefix: string): Promise<string> {
  await mkdir(parent, { recursive: true });
  for (let sequence = 1; sequence < 1_000_000; sequence += 1) {
    const path = join(parent, `${prefix}-${String(sequence).padStart(4, "0")}`);
    try {
      await mkdir(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`no available ${prefix} run directory under ${parent}`);
}

export interface OracleSanityResult {
  directory: string;
  manifestPath: string;
  views: string[];
  captureCount: number;
}

/**
 * First-class oracle-only sanity evidence for tank onboarding: renders the prepared oracle
 * alone from front/rear/left/right/top/perspective with canonical-frame metadata. This is
 * builder/onboarding sanity output — never external visual certification — and registration
 * locking for tank projects requires it to exist.
 */
export async function performOracleSanityRun(workspace: ResumedWorkspace, manifest: OracleManifest, oracle: import("three").Object3D, backend: RenderBackend = "deterministic-cpu"): Promise<OracleSanityResult> {
  const run = await createSanityRunDirectory(workspace.layout.internal.captures);
  const snapshot = snapshotScene(oracle);
  const bounds = measureBounds(snapshot);
  const frame = deriveCanonicalFrame(bounds, 0.01);
  const profile = standardRenderProfile({ width: frame.width, height: frame.height });
  profile.camera.orthographicHeight = frame.orthographicHeight;
  profile.camera.far = Math.max(profile.camera.far, frame.orthographicHeight * 4);
  await mkdir(run, { recursive: true });
  const span = Math.max(...bounds.size);
  const distance = span * 2.5 + 1;
  const [x, y, z] = bounds.center;
  const mirror = (camera: CaptureCamera, id: string): CaptureCamera => ({
    id,
    projection: "orthographic",
    position: [2 * camera.target[0] - camera.position[0], camera.position[1] === camera.target[1] ? camera.position[1] : 2 * camera.target[1] - camera.position[1], 2 * camera.target[2] - camera.position[2]] as const,
    target: camera.target,
  });
  const perspective: CaptureCamera = { id: "perspective", projection: "perspective", position: [x - distance * 0.7, y + distance * 0.35, z - distance * 0.7] as const, target: [x, y, z] as const };
  const views: Array<{ id: string; camera: CaptureCamera }> = [
    { id: "front", camera: frame.cameras.front },
    { id: "rear", camera: mirror(frame.cameras.front, "rear") },
    { id: "left-side", camera: mirror(frame.cameras.side, "left-side") },
    { id: "right-side", camera: { ...frame.cameras.side, id: "right-side" } },
    { id: "top", camera: { ...frame.cameras.plan, id: "top" } },
    { id: "perspective", camera: perspective },
  ];
  const captures: Array<{ view: string; path: string; sha256: string }> = [];
  for (const view of views) {
    const rendered = renderCapture({ root: oracle, snapshot, profile, camera: view.camera, pass: "beauty", backend });
    const path = join(run, `oracle-${view.id}.png`);
    await writeCapturePng(path, rendered.frame);
    captures.push({ view: view.id, path, sha256: sha256(await readFile(path)) });
  }
  const manifestPayload = {
    schemaVersion: 1,
    kind: "oracle-sanity-board",
    oracleHash: fingerprintScene(oracle),
    preparedOracleHash: manifest.preparedHash,
    canonicalFrame: { right: "+X", up: "+Y", forward: "+Z", ground: "minY" },
    axisLabels: { x: "lateral (right +)", y: "vertical (up +)", z: "longitudinal (forward +)" },
    frame: frame.frameHash,
    views: views.map((view) => view.id),
    captures,
  };
  const manifestPath = join(run, "oracle-sanity-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifestPayload, null, 2)}\n`, { flag: "wx" });
  return { directory: run, manifestPath, views: views.map((view) => view.id), captureCount: captures.length };
}

async function createSanityRunDirectory(parent: string): Promise<string> {
  await mkdir(parent, { recursive: true });
  for (let sequence = 1; sequence < 1_000_000; sequence += 1) {
    const path = join(parent, `oracle-sanity-${String(sequence).padStart(4, "0")}`);
    try {
      await mkdir(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`no available oracle-sanity run directory under ${parent}`);
}

export interface OracleSanityVerification {
  manifestPath: string;
  manifest: {
    schemaVersion: 1;
    kind: string;
    oracleHash: string;
    preparedOracleHash: string;
    views: string[];
    captures: Array<{ view: string; path: string; sha256: string }>;
    [key: string]: unknown;
  };
}

/**
 * Locates the newest oracle sanity board and proves it is authoritative for the CURRENT
 * preparation: the manifest must bind the live prepared-oracle hash and every referenced
 * capture must still hash to its recorded value. A board captured for an earlier preparation
 * can never satisfy a later registration lock.
 */
export async function verifyLatestOracleSanity(capturesDirectory: string, preparedOracleHash: string): Promise<OracleSanityVerification> {
  let names: string[];
  try {
    names = (await readdir(capturesDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  } catch {
    throw new Error("no oracle-sanity capture exists; run `mesh2threejs oracle-sanity WORKSPACE` before locking tank registration");
  }
  const sequence = (name: string): number => Number(name.match(/^oracle-sanity-(\d+)$/u)?.[1] ?? -1);
  const candidates = names.filter((name) => sequence(name) >= 0);
  let manifestPath: string | undefined;
  for (const name of candidates) {
    const candidatePath = join(capturesDirectory, name, "oracle-sanity-manifest.json");
    try {
      await readFile(candidatePath);
      manifestPath = candidatePath;
      break;
    } catch { /* inspect the next completed run */ }
  }
  if (!manifestPath) throw new Error("no completed oracle-sanity capture exists; run `mesh2threejs oracle-sanity WORKSPACE` before locking tank registration");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`oracle-sanity manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = manifestValue as OracleSanityVerification["manifest"];
  if (manifest.schemaVersion !== 1 || manifest.kind !== "oracle-sanity-board" || !Array.isArray(manifest.captures)) {
    throw new Error(`oracle-sanity manifest at ${manifestPath} is not a valid sanity board`);
  }
  if (manifest.preparedOracleHash !== preparedOracleHash) {
    throw new Error("the latest oracle-sanity board was captured for a different oracle preparation; rerun `mesh2threejs oracle-sanity WORKSPACE` for the current preparation");
  }
  for (const capture of manifest.captures) {
    let bytes: Buffer;
    try {
      bytes = await readFile(capture.path);
    } catch {
      throw new Error(`oracle-sanity capture file is missing: ${capture.path}`);
    }
    if (sha256(bytes) !== capture.sha256) {
      throw new Error(`oracle-sanity capture bytes changed since capture: ${capture.path}`);
    }
  }
  return { manifestPath, manifest };
}

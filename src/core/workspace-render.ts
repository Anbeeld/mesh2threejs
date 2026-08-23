import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OracleManifest } from "./oracle.js";
import type { CandidateIdentity } from "./candidate.js";
import { fingerprintScene, canonicalJson, sha256 } from "./hashing.js";
import { snapshotScene } from "./geometry.js";
import { measureBounds } from "./measurement.js";
import { compareRegionDiagnostics, createComparisonBoard, createTurntable, deriveCanonicalFrame, standardRenderProfile, writeCapturePng } from "./render.js";
import { renderCapture, type RenderBackend } from "./three-render.js";
import { bindEvidenceConfig, createRenderEvidenceArtifact, loadTaskState, recordEvidenceArtifact, saveTaskState } from "./state.js";
import { createWorkspaceResolver, type ResumedWorkspace } from "./workspace.js";
import type { CapturePass } from "../types.js";

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
  candidateIdentity: CandidateIdentity;
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

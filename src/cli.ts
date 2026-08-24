#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditCandidateModule } from "./core/candidate.js";
import { replayDeterministicRows, type DeterministicReplayPacket } from "./core/replay.js";
import { neutralPoseForProfile, requiredPosesForProfile, type PosedEvaluationBundle } from "./core/orchestration.js";
import { loadPreparedOracle, onboardOracle, oraclePreparationIdentity, probeGlb, repairPreparedOracle, verifyOracleRegistration, oraclePreparationBinding, type OnboardOracleInput, type OracleManifest, type RegistrationExpectation, type RepairPreparedOracleInput } from "./core/oracle.js";
import { routeSubject } from "./core/routing.js";
import { acceptPhase, bindCandidate, bindCandidatePhases, bindEvidenceConfig, bindOracle, bindOraclePreparation, certifyStateFromArtifacts, createAutomatedVisualAssessmentArtifact, createRenderEvidenceArtifact, createRuntimeEvaluationEvidenceArtifact, createRuntimeGateEvidenceArtifact, createWorkflowGateEvidenceArtifact, determineNextAction, isAuthoritativeEvidence, loadTaskState, recordAttempt, recordEvidenceArtifact, reopenPhase, saveTaskState, setAuthoritativeDimensionStatus, verifyEvidenceArtifact, type EvidenceArtifact, type EvidenceRecord } from "./core/state.js";
import { createWorkspaceResolver, initializeWorkspace, migrateWorkspace, rebindWorkspace, resolveStateTarget, resumeWorkspace, verifyWorkspaceOraclePreparation } from "./core/workspace.js";
import type { ProfileId } from "./types.js";
import { validateOracleManifest } from "./core/schema.js";
import { canonicalJson, fingerprintScene, sha256 } from "./core/hashing.js";
import { getProfileContract, profileContractHash } from "./core/contracts.js";
import { inspectAllUpstreamDrift } from "./core/upstream.js";
import type { GenericSubjectContract } from "./profiles/generic.js";
import { awaitingVisualReview, createVisualReviewPacket, verifyVisualReviewPacketFiles, verifyVisualReviewVerdict, type ReviewFileReference, type VisualReviewPacket, type VisualReviewVerdict } from "./core/review.js";
import { performRenderRun, performOracleSanityRun, performQuickDiagnosticRun, verifyLatestOracleSanity } from "./core/workspace-render.js";
import { startViewer, stopViewer, viewerStatus } from "./viewer/manager.js";
import { selectRepairGroup } from "./core/compare.js";
import { createEvaluationIdentity, EVALUATOR_VERSION, evaluationIdentityHash, MEASUREMENT_VERSION, optionalContractHash } from "./core/identity.js";
import { loadStyleContract } from "./styles/low-poly.js";
import { derivePhaseSeed, trustedGeneratedAuditOptions } from "./core/derive.js";
import { phaseSemanticScope } from "./core/phase-compose.js";
import { snapshotScene } from "./core/geometry.js";
import { assertAssemblyCoverage, evaluateAssemblyCoverage } from "./core/assembly.js";
import { serializeScene, serializedSceneHash } from "./core/scene-serialization.js";
import type { SandboxBackend } from "./core/candidate-sandbox.js";
import { developmentInProcessBackend } from "./core/dev-sandbox.js";
import { inspectWorkspaceCandidateViaExecutor, assertPhaseSemanticScope, workspaceGateOutcome, computeWorkspaceGate, applyGateEvidence } from "./operations/workspace-gate.js";
import type { TaskState } from "./core/state.js";

export { assertPhaseSemanticScope, workspaceGateOutcome };

interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

function parseOptions(args: string[]): { positional: string[]; options: Record<string, string>; optionValues: Record<string, string[]>; flags: Set<string> } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const optionValues: Record<string, string[]> = {};
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    if (equals >= 0) {
      const key = value.slice(2, equals);
      const optionValue = value.slice(equals + 1);
      options[key] = optionValue;
      (optionValues[key] ??= []).push(optionValue);
      continue;
    }
    const key = value.slice(2);
    if (key === "global" || key === "quick") {
      flags.add(key);
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`option ${value} requires a value`);
    options[key] = next;
    (optionValues[key] ??= []).push(next);
    index += 1;
  }
  return { positional, options, optionValues, flags };
}

function required(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function workspacePath(path: string, root?: string): string {
  return root && !isAbsolute(path) ? createWorkspaceResolver(root).resolveProjectPath(path) : resolve(path);
}

function storedArtifactPath(path: string, root?: string): string {
  if (!root) return path;
  try { return createWorkspaceResolver(root).toProjectPath(path); } catch { return resolve(path); }
}

/**
 * Automatically feeds every failed active-phase gate into the existing attempt/stagnation
 * machinery so three equivalent no-progress failures route to diagnose without the agent
 * having to remember manual bookkeeping.
 */
async function recordFailedGateAttempt(statePath: string, state: TaskState, phase: string, report: { rows: Array<{ code: string; passed: boolean }>; score?: number } | undefined): Promise<TaskState> {
  const failingCodes = (report?.rows ?? []).filter((row) => !row.passed).map((row) => row.code).sort();
  const next = recordAttempt(state, {
    action: `gate:${phase}`,
    evidenceHash: sha256(canonicalJson({ phase, failingCodes })),
    score: report ? report.score ?? 0 : 0,
  });
  await saveTaskState(statePath, next);
  return next;
}

async function optionalWorkspace(input: string): Promise<Awaited<ReturnType<typeof resumeWorkspace>> | undefined> {
  const absolute = resolve(input);
  let info;
  try { info = await stat(absolute); } catch { return undefined; }
  const canonicalState = basename(absolute) === "state.json" && basename(dirname(absolute)) === ".mesh2threejs";
  if (info.isDirectory() || basename(absolute) === "project.json" || canonicalState) return resumeWorkspace(absolute);
  return undefined;
}

/** In-process sandbox used by DEVELOPMENT runs only; it can never certify. */
export function developmentSandboxBackend(): SandboxBackend {
  return developmentInProcessBackend();
}

/** Refuses builder mutations against a workspace bound to a trusted run. */
function assertDevelopmentWorkspace(workspace: Awaited<ReturnType<typeof resumeWorkspace>>): void {
  if (workspace.state.mirrorOfRun) {
    throw new Error(`workspace is bound to trusted run ${workspace.state.mirrorOfRun.mirrorOfRun}; this low-level operation cannot mutate it (development-only interface)`);
  }
}

async function createRunDirectory(parent: string, prefix: string): Promise<{ id: string; path: string }> {
  await mkdir(parent, { recursive: true });
  for (let sequence = 1; sequence < 1_000_000; sequence += 1) {
    const id = `${prefix}-${String(sequence).padStart(4, "0")}`;
    const path = join(parent, id);
    try {
      await mkdir(path);
      return { id, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`no available ${prefix} run directory under ${parent}`);
}

async function latestRunFile(parent: string, prefix: string, filename: string): Promise<string> {
  const entries = await readdir(parent, { withFileTypes: true });
  const sequence = (name: string): number => Number(name.match(new RegExp(`^${prefix}-(\\d+)`, "u"))?.[1] ?? -1);
  const names = entries.filter((entry) => entry.isDirectory() && sequence(entry.name) >= 0).map((entry) => entry.name).sort((a, b) => sequence(b) - sequence(a));
  for (const name of names) {
    const path = join(parent, name, filename);
    try { await readFile(path); return path; } catch { /* inspect the next completed run */ }
  }
  throw new Error(`no completed ${prefix} run with ${filename} exists under ${parent}`);
}

async function latestSequentialFile(parent: string, prefix: string): Promise<string> {
  const entries = await readdir(parent, { withFileTypes: true });
  const sequence = (name: string): number => Number(name.match(new RegExp(`^${prefix}-(\\d+)\\.json$`, "u"))?.[1] ?? -1);
  const name = entries.filter((entry) => entry.isFile() && sequence(entry.name) >= 0).map((entry) => entry.name).sort((a, b) => sequence(b) - sequence(a))[0];
  if (!name) throw new Error(`no ${prefix} report exists under ${parent}`);
  return join(parent, name);
}

const HELP = `mesh2threejs commands:
  init WORKSPACE --id ID --goal TEXT --profile tank|generic [--ref PATH ...] [--oracle GLB] [--reference-mode copy|external] [--authorship derived|independent]
  migrate WORKSPACE [--oracle GLB] [--reference-mode copy|external]
  rebind WORKSPACE
  status WORKSPACE|STATE.json
  next WORKSPACE|STATE.json
  bind-oracle STATE.json --hash SHA256
  bind-candidate STATE.json --hash SHA256
  bind-config STATE.json --kind KIND --hash SHA256 --reason TEXT
  record-evidence STATE.json --artifact evidence.json
  lock WORKSPACE [--phase PHASE]
  lock STATE.json --phase PHASE --geometry-hash SHA256 --evidence ID[,ID]
  reopen STATE.json --phase PHASE --reason TEXT
  attempt STATE.json --action TEXT --evidence-hash SHA256 --score NUMBER
  prepare-review CONFIG.json --out packet.json
  review-status PACKET.json
  record-review WORKSPACE --verdict verdict.json
  record-review STATE.json --packet packet.json --verdict verdict.json --artifact evidence.json
  route TEXT
  upstream-drift
  probe GLB
  onboard WORKSPACE --config INPUT.json
  onboard --config INPUT.json --out manifest.json
  repair-oracle WORKSPACE --config repair.json
  repair-oracle --manifest manifest.json --config repair.json --out repaired-manifest.json
  register WORKSPACE --config expectation.json
  register --manifest manifest.json --config expectation.json [--profile tank|generic] [--out evidence.json]
  oracle-sanity WORKSPACE
  audit-candidate MODULE
  derive WORKSPACE [--quality aggressive|balanced|conservative]
  gate WORKSPACE [--global]
  gate --oracle manifest.json --candidate MODULE --profile tank|generic [--out report.json]
  render WORKSPACE [--phase active --quick]
  render --oracle manifest.json --candidate MODULE --out-dir DIR
  review-ready WORKSPACE [--renderer auto|deterministic-cpu|three-webgl]
  viewer start WORKSPACE [--port N|auto]
  viewer status WORKSPACE
  viewer stop WORKSPACE
  workorders WORKSPACE
  workorders REPORT.json [--phase PHASE]
  replay-gates PACKET.json [--out result.json]
  finalize STATE.json
`;

export async function runCli(argv: string[], io: CliIo = { stdout: console.log, stderr: console.error }): Promise<number> {
  const [command, ...args] = argv;
  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      io.stdout(HELP);
      return 0;
    }
    const parsed = parseOptions(args);
    switch (command) {
      case "init": {
        const profile = required(parsed.options, "profile");
        if (profile !== "tank" && profile !== "generic") throw new Error("--profile must be tank or generic");
        const workspace = parsed.positional[0] ?? parsed.options.workspace;
        if (!workspace) throw new Error("init requires a workspace path");
        const referenceMode = parsed.options["reference-mode"] ?? "copy";
        if (referenceMode !== "copy" && referenceMode !== "external") throw new Error("--reference-mode must be copy or external");
        const authorship = parsed.options.authorship;
        if (authorship !== undefined && authorship !== "derived" && authorship !== "independent") throw new Error("--authorship must be derived or independent");
        const result = await initializeWorkspace(workspace, {
          id: required(parsed.options, "id"),
          goal: required(parsed.options, "goal"),
          profile,
          style: parsed.options.style ?? "low-poly-faithful",
          certification: parsed.options.certification === "exact-real" ? "exact-real" : "oracle-relative",
          references: parsed.optionValues.ref ?? [],
          ...(parsed.options.oracle ? { oracle: parsed.options.oracle } : {}),
          ...(parsed.optionValues["image-ref"]?.length ? { images: parsed.optionValues["image-ref"] } : {}),
          ...(parsed.optionValues["doc-ref"]?.length ? { documents: parsed.optionValues["doc-ref"] } : {}),
          referenceMode,
          ...(parsed.options.model ? { model: parsed.options.model } : {}),
          ...(parsed.options["subject-contract"] ? { subjectContract: parsed.options["subject-contract"] } : {}),
          ...(authorship ? { authorshipMode: authorship } : {}),
        });
        io.stdout(json({ status: "initialized", taskId: required(parsed.options, "id"), ...result }));
        return 0;
      }
      case "migrate": {
        const workspace = parsed.positional[0] ?? parsed.options.workspace;
        if (!workspace) throw new Error("migrate requires a workspace path");
        const referenceMode = parsed.options["reference-mode"] ?? "copy";
        if (referenceMode !== "copy" && referenceMode !== "external") throw new Error("--reference-mode must be copy or external");
        const result = await migrateWorkspace(workspace, { ...(parsed.options.oracle ? { oracle: parsed.options.oracle } : {}), referenceMode });
        io.stdout(json({ status: "migrated", taskId: result.project.id, root: result.root }));
        return 0;
      }
      case "rebind": {
        const workspace = parsed.positional[0] ?? parsed.options.workspace;
        if (!workspace) throw new Error("rebind requires a workspace path");
        const result = await rebindWorkspace(workspace);
        io.stdout(json({ status: "rebound", taskId: result.state.taskId, projectConfigurationHash: result.state.projectConfigurationHash }));
        return 0;
      }
      case "route": {
        const prompt = parsed.positional.join(" ");
        if (!prompt) throw new Error("route requires task text");
        io.stdout(json({ profile: routeSubject(prompt) }));
        return 0;
      }
      case "upstream-drift": {
        io.stdout(json(await inspectAllUpstreamDrift()));
        return 0;
      }
      case "status": {
        const path = parsed.positional[0];
        if (!path) throw new Error("status requires a workspace or state path");
        const target = await resolveStateTarget(path);
        const state = target.workspaceRoot ? (await resumeWorkspace(target.workspaceRoot)).state : await loadTaskState(target.statePath);
        io.stdout(json({ taskId: state.taskId, status: state.status, route: state.route, activePhase: state.activePhase, phaseStatus: state.phaseStatus, visualReviewStatus: state.visualReviewStatus, locks: Object.keys(state.locks), unresolvedItems: state.unresolvedItems }));
        return 0;
      }
      case "next": {
        const path = parsed.positional[0];
        if (!path) throw new Error("next requires a workspace or state path");
        const target = await resolveStateTarget(path);
        const state = target.workspaceRoot ? (await resumeWorkspace(target.workspaceRoot)).state : await loadTaskState(target.statePath);
        io.stdout(json({ activePhase: state.activePhase, ...determineNextAction(state) }));
        return 0;
      }
      case "bind-oracle":
      case "bind-candidate": {
        const path = parsed.positional[0];
        if (!path) throw new Error(`${command} requires a state path`);
        const { statePath, workspaceRoot } = await resolveStateTarget(path);
        if (workspaceRoot) {
          const bound = await loadTaskState(createWorkspaceResolver(workspaceRoot).layout.internal.state);
          if (bound.mirrorOfRun) throw new Error(`workspace is bound to trusted run ${bound.mirrorOfRun.mirrorOfRun}; bind operations are development-only and cannot mutate it`);
        }
        const hash = required(parsed.options, "hash");
        const state = command === "bind-oracle" ? bindOracle(await loadTaskState(statePath), hash) : bindCandidate(await loadTaskState(statePath), hash);
        await saveTaskState(statePath, state);
        io.stdout(json({ status: "bound", oracleHash: state.oracleHash, candidateHash: state.candidateHash }));
        return 0;
      }
      case "bind-config": {
        const path = parsed.positional[0];
        if (!path) throw new Error("bind-config requires a state path");
        const kinds: EvidenceRecord["kind"][] = ["registration", "deterministic-gate", "style", "complexity", "articulation", "visual-review", "turntable"];
        const kind = required(parsed.options, "kind") as EvidenceRecord["kind"];
        if (!kinds.includes(kind)) throw new Error(`unsupported evidence kind: ${kind}`);
        const { statePath, workspaceRoot } = await resolveStateTarget(path);
        if (workspaceRoot) {
          const bound = await loadTaskState(createWorkspaceResolver(workspaceRoot).layout.internal.state);
          if (bound.mirrorOfRun) throw new Error(`workspace is bound to trusted run ${bound.mirrorOfRun.mirrorOfRun}; config binding is development-only and cannot mutate it`);
        }
        const state = bindEvidenceConfig(await loadTaskState(statePath), kind, required(parsed.options, "hash"), required(parsed.options, "reason"));
        await saveTaskState(statePath, state);
        io.stdout(json({ status: "config-bound", kind, configHash: state.evidenceConfigHashes[kind] }));
        return 0;
      }
      case "record-evidence": {
        const path = parsed.positional[0];
        if (!path) throw new Error("record-evidence requires a state path");
        const target = await resolveStateTarget(path);
        if (target.workspaceRoot) {
          const bound = await loadTaskState(createWorkspaceResolver(target.workspaceRoot).layout.internal.state);
          if (bound.mirrorOfRun) throw new Error(`workspace is bound to trusted run ${bound.mirrorOfRun.mirrorOfRun}; caller-supplied evidence recording cannot mutate a trusted run`);
        }
        const statePath = target.statePath;
        const artifactPath = workspacePath(required(parsed.options, "artifact"), target.workspaceRoot);
        const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as EvidenceArtifact;
        const state = recordEvidenceArtifact(await loadTaskState(statePath), storedArtifactPath(artifactPath, target.workspaceRoot), artifact);
        await saveTaskState(statePath, state);
        io.stdout(json({ status: "recorded", evidenceId: artifact.id, passed: artifact.result.passed }));
        return 0;
      }
      case "lock": {
        const path = parsed.positional[0];
        if (!path) throw new Error("lock requires a state path");
        const target = await resolveStateTarget(path);
        const { statePath } = target;
        let livePreparation: Awaited<ReturnType<typeof verifyWorkspaceOraclePreparation>> | undefined;
        if (target.workspaceRoot) {
          const workspace = await resumeWorkspace(target.workspaceRoot);
          assertDevelopmentWorkspace(workspace);
          if (workspace.project.oracle) livePreparation = await verifyWorkspaceOraclePreparation(workspace);
        }
        const current = await loadTaskState(statePath);
        const phase = parsed.options.phase ?? (target.workspaceRoot ? current.activePhase : undefined);
        if (!phase) throw new Error("lock state-file mode requires --phase");
        if (target.workspaceRoot && phase === "oracle-registration" && current.profile === "tank") {
          // Registration locking for tank projects requires a sanity board bound to the CURRENT
          // preparation with capture bytes re-hashed — stale boards cannot satisfy the lock.
          await verifyLatestOracleSanity(createWorkspaceResolver(target.workspaceRoot).layout.internal.captures, livePreparation!.binding.preparedHash);
        }
        const geometryHash = parsed.options["geometry-hash"] ?? (target.workspaceRoot ? (phase === "oracle-registration" ? current.oracleHash : current.phaseGeometryHashes[phase]) : undefined);
        if (!geometryHash) throw new Error(`no measured geometry is available for phase ${phase}; run registration/gate first or provide --geometry-hash`);
        const evidenceIds = parsed.options.evidence?.split(",").filter(Boolean) ?? (target.workspaceRoot ? Object.values(current.evidence).filter((item) => item.phase === phase && item.valid && item.verified && item.passed && isAuthoritativeEvidence(item)).map((item) => item.id) : []);
        const state = acceptPhase(current, phase, { geometryHash, evidenceIds, contractHash: current.profileContractHash });
        await saveTaskState(statePath, state);
        io.stdout(json({ status: "locked", activePhase: state.activePhase, locks: Object.keys(state.locks) }));
        return 0;
      }
      case "reopen": {
        const path = parsed.positional[0];
        if (!path) throw new Error("reopen requires a state path");
        const { statePath, workspaceRoot } = await resolveStateTarget(path);
        if (workspaceRoot) assertDevelopmentWorkspace(await resumeWorkspace(workspaceRoot));
        const state = reopenPhase(await loadTaskState(statePath), required(parsed.options, "phase"), required(parsed.options, "reason"));
        await saveTaskState(statePath, state);
        io.stdout(json({ status: "reopened", activePhase: state.activePhase }));
        return 0;
      }
      case "attempt": {
        const path = parsed.positional[0];
        if (!path) throw new Error("attempt requires a state path");
        const { statePath } = await resolveStateTarget(path);
        const score = Number(required(parsed.options, "score"));
        if (!Number.isFinite(score)) throw new Error("--score must be numeric");
        const state = recordAttempt(await loadTaskState(statePath), { action: required(parsed.options, "action"), evidenceHash: required(parsed.options, "evidence-hash"), score });
        await saveTaskState(statePath, state);
        io.stdout(json({ status: "recorded", route: state.route, attempts: state.attempts.length }));
        return 0;
      }
      case "prepare-review": {
        const inputPath = parsed.positional[0];
        if (!inputPath) throw new Error("prepare-review requires a workspace or config path");
        const workspace = await optionalWorkspace(inputPath);
        let packet: VisualReviewPacket;
        let outputPath: string;
        if (workspace) {
          await verifyWorkspaceOraclePreparation(workspace);
          const reviewRun = await createRunDirectory(workspace.layout.internal.visualReview, "review");
          const renderManifestPath = await latestRunFile(workspace.layout.internal.captures, "render", "render-manifest.json");
          const renderManifest = JSON.parse(await readFile(renderManifestPath, "utf8")) as { oracleHash: string; candidateHash: string; styleContractHash: string; evaluationIdentityHash: string; captures: Array<{ path: string; sha256: string; pass: string; cameraId: string }>; comparisonBoards: Array<{ path: string; sha256: string }>; turntable: Array<{ path: string; sha256: string }>; regionDiagnostics?: { path: string; sha256: string } };
          const state = await loadTaskState(workspace.layout.internal.state);
          const liveCandidate = await inspectWorkspaceCandidateViaExecutor({
            workspaceRoot: workspace.root,
            modelEntryPath: workspace.resolved.model,
            boundaryRoot: resolve(workspace.root, "model"),
            poses: [neutralPoseForProfile(workspace.project.profile)],
            auditOptions: await trustedGeneratedAuditOptions(workspace),
          });
          if (liveCandidate.candidateHash !== state.candidateHash || liveCandidate.candidateHash !== renderManifest.candidateHash) throw new Error("current workspace candidate differs from gated/reviewed candidate; rerun gate and review");
          if (state.oracleHash !== renderManifest.oracleHash || state.candidateHash !== renderManifest.candidateHash || state.styleContractHash !== renderManifest.styleContractHash || state.evaluationIdentityHash !== renderManifest.evaluationIdentityHash) throw new Error("latest render manifest is stale for the workspace state or evaluation configuration");
          const currentEvidence = Object.values(state.evidence).filter((item) => item.valid && item.verified && item.passed && isAuthoritativeEvidence(item) && (item.kind === "registration" || item.candidateHash === state.candidateHash));
          const deterministic = currentEvidence.filter((item) => item.kind === "deterministic-gate").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          const style = currentEvidence.filter((item) => item.kind === "style").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          const articulation = currentEvidence.filter((item) => item.kind === "articulation").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          const renderId = basename(dirname(renderManifestPath));
          const turntableEvidence = currentEvidence.find((item) => item.kind === "turntable" && item.id === `${renderId}-turntable`);
          if (!deterministic.length || !style || !turntableEvidence || (state.profile === "tank" && !articulation)) throw new Error("current passing gate/style/articulation/turntable evidence is incomplete");
          for (const item of deterministic) {
            const artifact = JSON.parse(await readFile(workspacePath(item.artifact, workspace.root), "utf8")) as EvidenceArtifact;
            verifyEvidenceArtifact(artifact);
            if (artifact.id !== item.id || artifact.artifactHash !== item.artifactHash) throw new Error(`deterministic evidence file contradicts state: ${item.id}`);
          }
          const deterministicIndexPath = join(reviewRun.path, "deterministic-evidence.json");
          await writeFile(deterministicIndexPath, `${json({ schemaVersion: 1, evidence: deterministic.map((item) => ({ id: item.id, path: item.artifact, artifactHash: item.artifactHash })) })}\n`, { flag: "wx" });
          const toFile = async (path: string, role: ReviewFileReference["role"], knownHash?: string): Promise<ReviewFileReference> => {
            const absolute = workspacePath(path, workspace!.root);
            return { path: storedArtifactPath(absolute, workspace!.root), sha256: knownHash ?? sha256(await readFile(absolute)), role };
          };
          const deterministicFile = await toFile(deterministicIndexPath, "deterministic");
          const styleFile = await toFile(style.artifact, "style");
          const articulationFile = articulation ? await toFile(articulation.artifact, "articulation") : undefined;
          const captureFiles = renderManifest.captures.map((item) => ({ path: item.path, sha256: item.sha256, role: "capture" as const }));
          const boardFiles = renderManifest.comparisonBoards.map((item) => ({ path: item.path, sha256: item.sha256, role: "comparison-board" as const }));
          const turntableFiles = renderManifest.turntable.map((item) => ({ path: item.path, sha256: item.sha256, role: "turntable" as const }));
          const regionFile = renderManifest.regionDiagnostics ? { ...renderManifest.regionDiagnostics, role: "region" as const } : undefined;
          packet = createVisualReviewPacket({
            oracleHash: renderManifest.oracleHash,
            candidateHash: renderManifest.candidateHash,
            profile: state.profile,
            profileContractHash: state.profileContractHash,
            styleContractHash: state.styleContractHash,
            evaluationIdentityHash: state.evaluationIdentityHash!,
            styleHash: styleFile.sha256,
            deterministicArtifactHash: deterministicFile.sha256,
            captures: renderManifest.captures.map(({ path, sha256: hash, pass, cameraId }) => ({ path, sha256: hash, pass, cameraId })),
            comparisonBoardHashes: boardFiles.map((item) => item.sha256),
            turntableHashes: turntableFiles.map((item) => item.sha256),
            ...(articulationFile ? { articulationArtifactHash: articulationFile.sha256 } : {}),
            regionEvidence: regionFile ? { status: "available", semanticArtifactHash: regionFile.sha256 } : { status: "unavailable", reason: "this render run did not emit semantic region diagnostics" },
            files: [...captureFiles, ...boardFiles, ...turntableFiles, deterministicFile, styleFile, ...(articulationFile ? [articulationFile] : []), ...(regionFile ? [regionFile] : [])],
          });
          outputPath = parsed.options.out ? workspacePath(parsed.options.out, workspace.root) : join(reviewRun.path, "packet.json");
          await verifyVisualReviewPacketFiles(packet, workspace.root);
        } else {
          const configPath = resolve(inputPath);
          const config = JSON.parse(await readFile(configPath, "utf8")) as Omit<VisualReviewPacket, "schemaVersion" | "packetHash">;
          packet = createVisualReviewPacket(config);
          outputPath = resolve(required(parsed.options, "out"));
          await verifyVisualReviewPacketFiles(packet, dirname(configPath));
        }
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, `${json(packet)}\n`, { flag: "wx" });
        io.stdout(json(awaitingVisualReview(packet)));
        return 0;
      }
      case "review-status": {
        const inputPath = parsed.positional[0];
        if (!inputPath) throw new Error("review-status requires a workspace or packet path");
        const workspace = await optionalWorkspace(inputPath);
        const packetPath = workspace ? await latestRunFile(workspace.layout.internal.visualReview, "review", "packet.json") : resolve(inputPath);
        const packet = JSON.parse(await readFile(packetPath, "utf8")) as VisualReviewPacket;
        await verifyVisualReviewPacketFiles(packet, workspace?.root ?? dirname(packetPath));
        io.stdout(json(awaitingVisualReview(packet)));
        return 0;
      }
      case "record-review": {
        const path = parsed.positional[0];
        if (!path) throw new Error("record-review requires a state path");
        const target = await resolveStateTarget(path);
        const statePath = target.statePath;
        const packetPath = parsed.options.packet
          ? workspacePath(parsed.options.packet, target.workspaceRoot)
          : target.workspaceRoot ? await latestRunFile(createWorkspaceResolver(target.workspaceRoot).layout.internal.visualReview, "review", "packet.json") : undefined;
        if (!packetPath) throw new Error("record-review state-file mode requires --packet");
        const packet = JSON.parse(await readFile(packetPath, "utf8")) as VisualReviewPacket;
        const verdict = JSON.parse(await readFile(workspacePath(required(parsed.options, "verdict"), target.workspaceRoot), "utf8")) as VisualReviewVerdict;
        verifyVisualReviewVerdict(packet, verdict);
        await verifyVisualReviewPacketFiles(packet, target.workspaceRoot ?? dirname(packetPath));
        let state = await loadTaskState(statePath);
        if (target.workspaceRoot) {
          assertDevelopmentWorkspace(await resumeWorkspace(target.workspaceRoot));
          const workspace = await resumeWorkspace(target.workspaceRoot);
          if (workspace.project.oracle) await verifyWorkspaceOraclePreparation(workspace);
          const liveCandidate = await inspectWorkspaceCandidateViaExecutor({
            workspaceRoot: workspace.root,
            modelEntryPath: workspace.resolved.model,
            boundaryRoot: resolve(workspace.root, "model"),
            poses: [neutralPoseForProfile(workspace.project.profile)],
            auditOptions: await trustedGeneratedAuditOptions(workspace),
          });
          if (liveCandidate.candidateHash !== state.candidateHash || liveCandidate.candidateHash !== packet.candidateHash) throw new Error("current workspace candidate differs from gated/reviewed candidate; rerun gate and review");
        }
        if (state.oracleHash !== packet.oracleHash || state.candidateHash !== packet.candidateHash || state.profileContractHash !== packet.profileContractHash || state.styleContractHash !== packet.styleContractHash || state.evaluationIdentityHash !== packet.evaluationIdentityHash) throw new Error("visual review is bound to stale state or evaluation configuration");
        // A builder/model-created verdict file is DATA, never human authority (§15.3): it is
        // recorded as an automated visual diagnostic that can inform workorders/reopens but
        // can never satisfy the visual.review gate or certification.
        const reviewSequence = Object.values(state.evidence).filter((item) => item.kind === "visual-review").length + 1;
        const artifact = createAutomatedVisualAssessmentArtifact({ id: `visual-assessment-${String(reviewSequence).padStart(4, "0")}`, phase: "visual-review", oracleHash: packet.oracleHash, candidateHash: packet.candidateHash, profileContractHash: packet.profileContractHash, styleContractHash: packet.styleContractHash, evaluationIdentityHash: packet.evaluationIdentityHash, configHash: packet.packetHash, verdict: { verdict: verdict.verdict, findings: verdict.findings }, packetHash: packet.packetHash });
        state = bindEvidenceConfig(state, "visual-review", packet.packetHash, "recording a new explicitly reviewed capture packet");
        const defaultReviewRun = !parsed.options.artifact && target.workspaceRoot ? await createRunDirectory(createWorkspaceResolver(target.workspaceRoot).layout.internal.evidence, "review") : undefined;
        const artifactPath = parsed.options.artifact ? workspacePath(parsed.options.artifact, target.workspaceRoot) : defaultReviewRun ? join(defaultReviewRun.path, "visual-review.json") : undefined;
        if (!artifactPath) throw new Error("record-review state-file mode requires --artifact");
        await mkdir(dirname(artifactPath), { recursive: true });
        await writeFile(artifactPath, `${json(artifact)}\n`, { flag: "wx" });
        state = recordEvidenceArtifact(state, storedArtifactPath(artifactPath, target.workspaceRoot), artifact);
        await saveTaskState(statePath, state);
        io.stdout(json({
          status: "automated-visual-diagnostic-recorded",
          diagnosticVerdict: verdict.verdict,
          evidenceId: artifact.id,
          note: "automated/model verdicts are diagnostic only; trusted certification requires human approval through the run authority channel",
        }));
        return verdict.verdict === "PASS" ? 0 : 5;
      }
      case "probe": {
        const path = parsed.positional[0];
        if (!path) throw new Error("probe requires a GLB path");
        io.stdout(json(probeGlb(await readFile(resolve(path)))));
        return 0;
      }
      case "onboard": {
        const configPath = required(parsed.options, "config");
        const config = JSON.parse(await readFile(resolve(configPath), "utf8")) as OnboardOracleInput;
        const workspaceInput = parsed.positional[0] ?? parsed.options.workspace;
        const workspace = workspaceInput ? await resumeWorkspace(workspaceInput) : undefined;
        if (workspace) {
          assertDevelopmentWorkspace(workspace);
          if (!workspace.project.oracle) throw new Error("workspace has no oracle reference to onboard");
        }
        const oracleRecord = workspace?.references.records.find((record) => record.kind === "oracle" && record.operationalPath === workspace.project.oracle);
        if (workspace && !oracleRecord) throw new Error("workspace oracle is absent from the reference index");
        const outputPath = workspace?.layout.internal.oracleManifest ?? resolve(required(parsed.options, "out"));
        const manifest = await onboardOracle(workspace && oracleRecord ? {
          ...config,
          workspaceRoot: workspace.root,
          sourcePath: oracleRecord.operationalPath,
          sourceOriginalPath: oracleRecord.originalPath,
          referenceMode: oracleRecord.mode,
          preparedPath: createWorkspaceResolver(workspace.root).toProjectPath(workspace.layout.internal.preparedOracle),
        } : config);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, `${json(manifest)}\n`, { flag: "wx" });
        if (workspace) {
          const current = await loadTaskState(workspace.layout.internal.state);
          const requiredDimensions = getProfileContract(current.profile).dimensions;
          const dimensions = manifest.authoritativeDimensions;
          const admitted = Boolean(dimensions && manifest.dimensionSources.length && requiredDimensions.every((key) => Number.isFinite(dimensions[key]) && dimensions[key]! > 0));
          const bound = bindOraclePreparation(current, oraclePreparationBinding(manifest), `oracle onboarding admitted preparation ${manifest.preparedHash}`);
          const state = setAuthoritativeDimensionStatus(bound, admitted ? "admitted" : "not-admitted", admitted ? manifest.dimensionSources : []);
          await saveTaskState(workspace.layout.internal.state, state);
        }
        io.stdout(json({ status: "onboarded", manifest: outputPath, sourceHash: manifest.sourceHash, preparedHash: manifest.preparedHash }));
        return 0;
      }
      case "repair-oracle": {
        const workspaceInput = parsed.positional[0] ?? parsed.options.workspace;
        const workspace = workspaceInput ? await resumeWorkspace(workspaceInput) : undefined;
        if (workspace) assertDevelopmentWorkspace(workspace);
        let manifest: OracleManifest;
        if (workspace) {
          // Repair operates on the admitted preparation of this workspace, never on whatever
          // self-consistent manifest happens to sit at the canonical path.
          manifest = (await verifyWorkspaceOraclePreparation(workspace)).manifest;
        } else {
          manifest = JSON.parse(await readFile(resolve(required(parsed.options, "manifest")), "utf8")) as OracleManifest;
          if (!validateOracleManifest(manifest).valid) throw new Error("oracle manifest schema is invalid");
        }
        const config = JSON.parse(await readFile(resolve(required(parsed.options, "config")), "utf8")) as RepairPreparedOracleInput;
        const repaired = await repairPreparedOracle(manifest, workspace ? {
          ...config,
          preparedPath: `.mesh2threejs/oracle/prepared-repair-${manifest.repairHistory.length + 1}.json`,
        } : config, workspace?.root);
        const outputPath = workspace?.layout.internal.oracleManifest ?? resolve(required(parsed.options, "out"));
        await writeFile(outputPath, `${json(repaired)}\n`, workspace ? undefined : { flag: "wx" });
        if (workspace) {
          const current = await loadTaskState(workspace.layout.internal.state);
          await saveTaskState(workspace.layout.internal.state, bindOraclePreparation(current, oraclePreparationBinding(repaired), `oracle repair: ${config.reason}`));
        }
        io.stdout(json({ status: "repaired", manifest: outputPath, sourceHash: repaired.sourceHash, preparedHash: repaired.preparedHash }));
        return 0;
      }
      case "register": {
        const workspaceInput = parsed.positional[0] ?? parsed.options.workspace;
        const workspace = workspaceInput ? await resumeWorkspace(workspaceInput) : undefined;
        let manifest: OracleManifest;
        let preparationIdentity: string;
        if (workspace) {
          const preparation = await verifyWorkspaceOraclePreparation(workspace);
          manifest = preparation.manifest;
          preparationIdentity = preparation.binding.identity;
        } else {
          manifest = JSON.parse(await readFile(resolve(required(parsed.options, "manifest")), "utf8")) as OracleManifest;
          if (!validateOracleManifest(manifest).valid) throw new Error("oracle manifest schema is invalid");
          preparationIdentity = oraclePreparationIdentity(manifest);
        }
        const expectation = JSON.parse(await readFile(resolve(required(parsed.options, "config")), "utf8")) as RegistrationExpectation;
        const registrationProfile = (workspace?.project.profile ?? parsed.options.profile) as "tank" | "generic" | undefined;
        if (registrationProfile !== undefined && registrationProfile !== "tank" && registrationProfile !== "generic") throw new Error("--profile must be tank or generic");
        const oracle = await loadPreparedOracle(manifest, workspace?.root);
        const evidence = verifyOracleRegistration(oracle, expectation, { ...(registrationProfile ? { profile: registrationProfile } : {}), ...(manifest.scaleAuthority ? { scaleAuthority: manifest.scaleAuthority } : {}) });
        // Source assembly coverage is part of registration (§11.4): unresolved significant
        // geometry under mapped critical assemblies fails the registration gate outright.
        const assemblyCoverage = registrationProfile === "tank" ? evaluateAssemblyCoverage(oracle, "tank") : undefined;
        const registrationPassed = evidence.passed && (assemblyCoverage?.passed ?? true);
        const rendered = `${json({ ...evidence, ...(assemblyCoverage ? { assemblyCoverage } : {}), passed: registrationPassed })}\n`;
        const registrationRun = workspace ? await createRunDirectory(workspace.layout.internal.evidence, "registration") : undefined;
        const reportPath = registrationRun ? join(workspace!.layout.internal.reports, `${registrationRun.id}.json`) : (parsed.options.out ? resolve(parsed.options.out) : undefined);
        if (reportPath) { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, rendered, { flag: "wx" }); }
        const stateOption = workspace?.layout.internal.state ?? parsed.options.state;
        const artifactOption = registrationRun ? join(registrationRun.path, "registration.json") : parsed.options.artifact;
        if (stateOption || artifactOption) {
          if (!stateOption || !artifactOption) throw new Error("registration state recording requires both --state and --artifact");
          const statePath = resolve(stateOption);
          let state = bindOracle(await loadTaskState(statePath), fingerprintScene(oracle));
          const registrationConfigHash = sha256(canonicalJson({ expectation, oraclePreparation: preparationIdentity }));
          state = bindEvidenceConfig(state, "registration", registrationConfigHash, "registration expectation changed");
          const artifact = createWorkflowGateEvidenceArtifact({ id: registrationRun?.id ?? "registration", kind: "registration", phase: "oracle-registration", oracleHash: state.oracleHash!, candidateHash: null, profileContractHash: state.profileContractHash, styleContractHash: state.styleContractHash, evaluationIdentityHash: null, configHash: registrationConfigHash, gateCode: "registration.complete", passed: registrationPassed, summary: registrationPassed ? "reference registration passed" : `reference registration failed${assemblyCoverage && !assemblyCoverage.passed ? `: ${assemblyCoverage.unresolved.length} significant source mesh(es) lack phase ownership` : ""}`, details: { registration: evidence, ...(assemblyCoverage ? { assemblyCoverage } : {}) } });
          const artifactPath = resolve(artifactOption);
          await mkdir(dirname(artifactPath), { recursive: true });
          await writeFile(artifactPath, `${json(artifact)}\n`, { flag: "wx" });
          state = recordEvidenceArtifact(state, storedArtifactPath(artifactPath, workspace?.root), artifact);
          await saveTaskState(statePath, state);
        }
        io.stdout(rendered.trimEnd());
        return registrationPassed ? 0 : 4;
      }
      case "oracle-sanity": {
        const workspaceInput = parsed.positional[0] ?? parsed.options.workspace;
        if (!workspaceInput) throw new Error("oracle-sanity requires a workspace path");
        const workspace = await resumeWorkspace(workspaceInput);
        const manifest = (await verifyWorkspaceOraclePreparation(workspace)).manifest;
        const oracle = await loadPreparedOracle(manifest, workspace.root);
        const result = await performOracleSanityRun(workspace, manifest, oracle);
        io.stdout(json({
          status: "oracle-sanity-captured",
          directory: storedArtifactPath(result.directory, workspace.root),
          manifest: storedArtifactPath(result.manifestPath, workspace.root),
          views: result.views,
          note: "builder/onboarding sanity evidence; not external visual certification",
        }));
        return 0;
      }
      case "audit-candidate": {
        const path = parsed.positional[0];
        if (!path) throw new Error("audit-candidate requires a module path");
        const result = await auditCandidateModule(resolve(path));
        io.stdout(json(result));
        return result.passed ? 0 : 3;
      }
      case "derive": {
        const workspaceInput = parsed.positional[0] ?? parsed.options.workspace;
        if (!workspaceInput) throw new Error("derive requires a workspace path");
        assertDevelopmentWorkspace(await resumeWorkspace(workspaceInput));
        const quality = parsed.options.quality;
        if (quality !== undefined && !["aggressive", "balanced", "conservative"].includes(quality)) throw new Error("--quality must be aggressive, balanced, or conservative");
        const result = await derivePhaseSeed(workspaceInput, { ...(quality ? { quality: quality as "aggressive" | "balanced" | "conservative" } : {}) });
        io.stdout(json({ status: result.status, phase: result.phase, operator: result.operator, tiers: result.tiers, ...(result.generatedModule ? { generatedModule: result.generatedModule } : {}), ...(result.manifest ? { manifest: result.manifest } : {}), ...(result.selected ? { selected: result.selected } : {}), wiring: result.wiring ?? undefined, ...(result.note ? { note: result.note } : {}) }));
        return result.status === "seed-passing" ? 0 : 4;
      }
      case "gate": {
        const workspaceInput = parsed.positional[0] ?? parsed.options.workspace;
        const workspace = workspaceInput ? await resumeWorkspace(workspaceInput) : undefined;
        if (workspace) assertDevelopmentWorkspace(workspace);
        if (workspace) {
          // Workspace mode shares the ONE operation implementation with the trusted pipeline
          // (closure plan §5.B1): compute -> persist evidence files -> mutate state.
          const isGlobal = parsed.flags.has("global");
          const gateRun = await createRunDirectory(workspace.layout.internal.evidence, "gate");
          const computation = await computeWorkspaceGate(workspace, { isGlobal, toolchainId: null, projectPolicyHash: null, artifactRunId: gateRun.id });
          const evaluation = computation.evaluation;
          const currentEvaluationHash = computation.evaluationIdentityHash;
          const reportPath = join(workspace.layout.internal.reports, `${gateRun.id}.json`);
          await mkdir(dirname(reportPath), { recursive: true });
          await writeFile(reportPath, `${json(evaluation)}\n`, { flag: "wx" });
          const cachePath = isGlobal ? join(workspace.layout.internal.reports, "gate-cache.json") : undefined;
          if (cachePath) {
            // Identity-keyed whole-object gate cache: identical candidate bytes + identity reuse
            // the cached evaluation; any drift recomputes from scratch.
            try { await rm(cachePath); } catch { /* first write */ }
            const temporary = `${cachePath}.${process.pid}.tmp`;
            await writeFile(temporary, `${json({ identity: computation.evaluationIdentity, candidateFiles: computation.execution.candidateFiles, evaluation })}\n`, { flag: "wx" });
            await rename(temporary, cachePath);
          }
          const written: Array<{ path: string; artifact: EvidenceArtifact }> = [];
          for (const { artifact } of computation.artifacts) {
            const artifactPath = join(gateRun.path, `${artifact.id}.json`);
            await writeFile(artifactPath, `${json(artifact)}\n`, { flag: "wx" });
            written.push({ path: artifactPath, artifact });
          }
          let state = applyGateEvidence(await loadTaskState(workspace.layout.internal.state), computation, (s, artifact) => {
            const entry = written.find((item) => item.artifact.id === artifact.id)!;
            return recordEvidenceArtifact(s, storedArtifactPath(entry.path, workspace.root), artifact);
          }, computation.evaluationIdentity);
          await saveTaskState(resolve(workspace.layout.internal.state), state);
          const outcome = workspaceGateOutcome(evaluation, workspace.state.activePhase);
          // A failed active-phase gate is automatically an attempt record: three equivalent
          // no-progress failures now reach diagnose without manual `attempt` bookkeeping.
          if (!isGlobal && !outcome.activePhasePassed) {
            const activeReport = evaluation.phaseGates[workspace.state.activePhase];
            const updated = await recordFailedGateAttempt(resolve(workspace.layout.internal.state), state, workspace.state.activePhase, activeReport ? { rows: activeReport.rows, score: activeReport.score } : undefined);
            state = updated;
          }
          if (!isGlobal) {
            const active = workspace.state.activePhase;
            const activeReport = evaluation.phaseGates[active];
            // Truly phase-local output: no future-phase scores, diagnostics, or global
            // style/articulation contents leak into the normal gate stream.
            const filtered = activeReport
              ? {
                  profile: evaluation.deterministic.profile,
                  activePhase: active,
                  passed: outcome.activePhasePassed,
                  score: activeReport.score,
                  deterministic: activeReport,
                  workorders: activeReport.workorders,
                  oracleHash: evaluation.oracleHash,
                  candidateHash: evaluation.candidateHash,
                  phaseGeometryHashes: evaluation.phaseGeometryHashes[active] ? { [active]: evaluation.phaseGeometryHashes[active] } : {},
                  note: "active-phase only; use --global for whole-object diagnostics",
                }
              : evaluation;
            io.stdout(json(filtered));
          } else {
            io.stdout(json({ ...evaluation, ...outcome }));
          }
          const { activePhasePassed, globalPassed } = outcome;
          return (isGlobal ? globalPassed : activePhasePassed) ? 0 : 4;
        }
        let manifest: OracleManifest;
        let preparationIdentity: string;
        manifest = JSON.parse(await readFile(resolve(required(parsed.options, "oracle")), "utf8")) as OracleManifest;
        if (!validateOracleManifest(manifest).valid) throw new Error("oracle manifest schema is invalid");
        preparationIdentity = oraclePreparationIdentity(manifest);
        const profile = required(parsed.options, "profile") as ProfileId;
        if (profile !== "tank" && profile !== "generic") throw new Error("--profile must be tank or generic");
        const subjectContractPath = parsed.options["subject-contract"] ? resolve(parsed.options["subject-contract"]) : undefined;
        const subjectContract = subjectContractPath ? JSON.parse(await readFile(subjectContractPath, "utf8")) as GenericSubjectContract : undefined;
        const candidatePath = resolve(required(parsed.options, "candidate"));
        const isGlobal = parsed.flags.has("global");
        const profileContract = getProfileContract(profile);
        const needsArticulation = isGlobal || profileContract.gates.some((gate) => gate.code === "articulation.poses" && gate.phase === undefined);
        void needsArticulation;
        const poses = requiredPosesForProfile(profile, subjectContract);
        const execution = await inspectWorkspaceCandidateViaExecutor({
          modelEntryPath: candidatePath,
          poses,
        });
        const candidateFiles = execution.candidateFiles;
        const certification: TaskState["certification"] = manifest.authoritativeDimensions ? "exact-real" : "oracle-relative";
        const selectedStyle = await loadStyleContract(parsed.options.style ?? "low-poly-faithful");
        const evaluationIdentity = createEvaluationIdentity({
          evaluatorVersion: EVALUATOR_VERSION,
          measurementVersion: MEASUREMENT_VERSION,
          profile,
          profileContractHash: profileContractHash(getProfileContract(profile)),
          styleContractHash: selectedStyle.hash,
          subjectContractHash: optionalContractHash(subjectContract),
          certification,
          oraclePreparationHash: preparationIdentity,
          preparedOracleHash: manifest.preparedHash,
          authoritativeDimensionsHash: optionalContractHash(manifest.authoritativeDimensions),
          candidateSourceHash: execution.sourceHash,
          candidateNeutralHash: execution.neutralSceneHash,
          toolchainId: null,
          projectPolicyHash: null,
          candidateIsolation: execution.isolation,
        });
        const currentEvaluationHash = evaluationIdentityHash(evaluationIdentity);
        const oracle = await loadPreparedOracle(manifest);
        const { evaluateCandidateFromSamples } = await import("./core/orchestration.js");
        const evaluation = await evaluateCandidateFromSamples({
          oracle,
          candidateSamples: [
            { pose: poses[0]!, root: execution.neutralRoot },
            ...execution.posedRoots.map((sample) => ({ pose: sample.pose, root: sample.root })),
          ],
          profile,
          candidateNeutralHash: execution.neutralSceneHash,
          candidateSourceHash: execution.sourceHash,
          style: selectedStyle.contract,
          certification,
          ...(subjectContract ? { subjectContract } : {}),
          ...(manifest.authoritativeDimensions ? { authoritativeDimensions: manifest.authoritativeDimensions } : {}),
        });
        const rendered = `${json(evaluation)}\n`;
        const reportPath2 = parsed.options.out ? resolve(parsed.options.out) : undefined;
        if (reportPath2) { await mkdir(dirname(reportPath2), { recursive: true }); await writeFile(reportPath2, rendered, { flag: "wx" }); }
        const artifactDirOption = parsed.options["artifact-dir"];
        if (artifactDirOption) {
          const parentDirectory = resolve(artifactDirOption);
          const run = await createRunDirectory(parentDirectory, "gate");
          for (const kind of ["deterministic-gate", "style", "complexity"] as const) {
            void kind;
            break;
          }
          const complexityRows = evaluation.style.rows.filter((row) => row.code.startsWith("style.complexity"));
          const complexityReport = { profile, passed: complexityRows.every((row) => row.passed), score: complexityRows.length ? Math.min(...complexityRows.map((row) => row.score)) : 0, rows: complexityRows, workorders: [] };
          const artifacts = [
            ...Object.entries(evaluation.phaseGates).map(([phase, report]) => createRuntimeGateEvidenceArtifact({ id: `${run.id}-${phase}`, phase, oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: evaluationIdentity.profileContractHash, styleContractHash: evaluationIdentity.styleContractHash, evaluationIdentityHash: currentEvaluationHash, configHash: currentEvaluationHash, report })),
            createRuntimeEvaluationEvidenceArtifact({ id: `${run.id}-style`, kind: "style", phase: profile === "tank" ? "style-fabrication" : "style-complexity", oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: evaluationIdentity.profileContractHash, styleContractHash: evaluationIdentity.styleContractHash, evaluationIdentityHash: currentEvaluationHash, configHash: currentEvaluationHash, report: evaluation.style }),
            createRuntimeEvaluationEvidenceArtifact({ id: `${run.id}-complexity`, kind: "complexity", phase: profile === "tank" ? "style-fabrication" : "style-complexity", oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: evaluationIdentity.profileContractHash, styleContractHash: evaluationIdentity.styleContractHash, evaluationIdentityHash: currentEvaluationHash, configHash: currentEvaluationHash, report: complexityReport }),
            ...(evaluation.articulation.rows.length ? [createRuntimeEvaluationEvidenceArtifact({ id: `${run.id}-articulation`, kind: "articulation", phase: evaluation.articulation.rows[0]!.phase ?? (profile === "tank" ? "fittings-articulation" : "attachments"), oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: evaluationIdentity.profileContractHash, styleContractHash: evaluationIdentity.styleContractHash, evaluationIdentityHash: currentEvaluationHash, configHash: currentEvaluationHash, report: evaluation.articulation })] : []),
          ];
          for (const artifact of artifacts) {
            await writeFile(join(run.path, `${artifact.id}.json`), `${json(artifact)}\n`, { flag: "wx" });
          }
        }
        io.stdout(rendered.trimEnd());
        return evaluation.passed ? 0 : 4;
      }
      case "render": {
        const workspaceInput = parsed.positional[0] ?? parsed.options.workspace;
        const workspace = workspaceInput ? await resumeWorkspace(workspaceInput) : undefined;
        if (parsed.flags.has("quick")) {
          if (!workspace) throw new Error("render --quick requires a workspace path");
          const requestedPhase = parsed.options.phase;
          if (requestedPhase && requestedPhase !== "active") throw new Error("--phase must be \"active\" for quick diagnostics");
          const manifestQuick = (await verifyWorkspaceOraclePreparation(workspace)).manifest;
          const oracleQuick = await loadPreparedOracle(manifestQuick, workspace.root);
          const candidateIdentityQuick = await inspectWorkspaceCandidateViaExecutor({
            workspaceRoot: workspace.root,
            modelEntryPath: workspace.resolved.model,
            boundaryRoot: resolve(workspace.root, "model"),
            poses: [neutralPoseForProfile(workspace.project.profile)],
            auditOptions: await trustedGeneratedAuditOptions(workspace),
          });
          if (candidateIdentityQuick.candidateHash !== workspace.state.candidateHash) throw new Error("current workspace candidate differs from gated candidate; rerun gate before rendering");
          const resultQuick = await performQuickDiagnosticRun(workspace, manifestQuick, oracleQuick, candidateIdentityQuick, candidateIdentityQuick.neutralRoot);
          io.stdout(json({
            status: "quick-diagnostic-captured",
            directory: storedArtifactPath(resultQuick.directory, workspace.root),
            manifest: storedArtifactPath(resultQuick.manifestPath, workspace.root),
            views: ["side", "front", "perspective"],
            boards: resultQuick.boards.map((board) => storedArtifactPath(board.path, workspace.root)),
            note: "builder diagnostic only; never satisfies visual.review and records no evidence",
          }));
          return 0;
        }
        let manifest: OracleManifest;
        if (workspace) {
          assertDevelopmentWorkspace(workspace);
          manifest = (await verifyWorkspaceOraclePreparation(workspace)).manifest;
        } else {
          manifest = JSON.parse(await readFile(resolve(required(parsed.options, "oracle")), "utf8")) as OracleManifest;
          if (!validateOracleManifest(manifest).valid) throw new Error("oracle manifest schema is invalid");
        }
        const oracle = await loadPreparedOracle(manifest, workspace?.root);
        const execution = await inspectWorkspaceCandidateViaExecutor({
          ...(workspace ? { workspaceRoot: workspace.root, boundaryRoot: resolve(workspace.root, "model"), auditOptions: await trustedGeneratedAuditOptions(workspace) } : {}),
          modelEntryPath: workspace?.resolved.model ?? resolve(required(parsed.options, "candidate")),
          poses: [neutralPoseForProfile(workspace?.project.profile ?? "generic")],
        });
        if (workspace && execution.candidateHash !== workspace.state.candidateHash) throw new Error("current workspace candidate differs from gated candidate; rerun gate before rendering");
        const renderRun = workspace ? await createRunDirectory(workspace.layout.internal.captures, "render") : undefined;
        const directory = renderRun?.path ?? resolve(required(parsed.options, "out-dir"));
        // Trusted viewer artifact: the serialized evaluated scene travels with the render run
        // so the interactive viewer can display exactly what was inspected (§14).
        const sceneArtifactPath = join(directory, "viewer-scene.json");
        await writeFile(sceneArtifactPath, `${json({ schemaVersion: 1, candidateHash: execution.candidateHash, sceneHash: execution.sceneHash, serialization: execution.serialization })}\n`, { flag: "wx" });
        const result = await performRenderRun({
          ...(workspace ? { workspace } : {}),
          manifest,
          candidateIdentity: { candidateHash: execution.candidateHash },
          candidate: execution.neutralRoot,
          oracle,
          directory,
          ...(renderRun ? { runId: renderRun.id } : {}),
          ...(parsed.options.renderer ? { backend: parsed.options.renderer } : {}),
          ...(parsed.options.precision ? { precision: Number(parsed.options.precision) } : {}),
        });
        io.stdout(json({ status: `rendered-${result.backend}`, manifest: result.manifestPath, captures: result.captureCount, turntable: result.turntable.length, sceneArtifact: storedArtifactPath(sceneArtifactPath, workspace?.root) }));
        return 0;
      }
      case "review-ready": {
        const workspaceInput = parsed.positional[0] ?? parsed.options.workspace;
        if (!workspaceInput) throw new Error("review-ready requires a workspace path");
        // User-review handoff: prove the live workspace/oracle/candidate identity, then refresh
        // the full capture set through the same render implementation as `render`. This command
        // never starts the interactive viewer; it only reports capture paths and viewer status.
        const workspace = await resumeWorkspace(workspaceInput);
        assertDevelopmentWorkspace(workspace);
        const manifest = (await verifyWorkspaceOraclePreparation(workspace)).manifest;
        const oracle = await loadPreparedOracle(manifest, workspace.root);
        const execution = await inspectWorkspaceCandidateViaExecutor({
          workspaceRoot: workspace.root,
          modelEntryPath: workspace.resolved.model,
          boundaryRoot: resolve(workspace.root, "model"),
          poses: [neutralPoseForProfile(workspace.project.profile)],
          auditOptions: await trustedGeneratedAuditOptions(workspace),
        });
        const candidateIdentity = {
          candidateHash: execution.candidateHash,
          sourceHash: execution.sourceHash,
          neutralSceneHash: execution.neutralSceneHash,
          candidateFiles: execution.candidateFiles,
        };
        if (candidateIdentity.candidateHash !== workspace.state.candidateHash) throw new Error("current workspace candidate differs from gated candidate; rerun gate before handing off user-review captures");
        const renderRun = await createRunDirectory(workspace.layout.internal.captures, "render");
        const sceneArtifactPath = join(renderRun.path, "viewer-scene.json");
        await writeFile(sceneArtifactPath, `${json({ schemaVersion: 1, candidateHash: execution.candidateHash, sceneHash: execution.sceneHash, serialization: execution.serialization })}\n`, { flag: "wx" });
        const result = await performRenderRun({
          workspace,
          manifest,
          candidateIdentity: { candidateHash: candidateIdentity.candidateHash },
          candidate: execution.neutralRoot,
          oracle,
          directory: renderRun.path,
          runId: renderRun.id,
          ...(parsed.options.renderer ? { backend: parsed.options.renderer } : {}),
        });
        const viewer = await viewerStatus(workspace.root);
        io.stdout(json({
          status: "ready-for-user-review",
          candidateHash: candidateIdentity.candidateHash,
          capture: {
            run: renderRun.id,
            directory: storedArtifactPath(renderRun.path, workspace.root),
            manifest: storedArtifactPath(result.manifestPath, workspace.root),
            boards: result.comparisonBoards.map((board) => board.path),
            turntable: `${storedArtifactPath(renderRun.path, workspace.root)}/turntable/`,
            viewerScene: storedArtifactPath(sceneArtifactPath, workspace.root),
          },
          viewer: viewer.status === "running"
            ? { status: "running", url: viewer.record.url }
            : { status: viewer.status, startCommand: "mesh2threejs viewer start <workspace>" },
          note: "viewer start is not builder-autonomous in trusted mode and always requires explicit user approval",
        }));
        return 0;
      }
      case "viewer": {
        const action = parsed.positional[0];
        const workspaceInput = parsed.positional[1] ?? parsed.options.workspace;
        if (!action || !workspaceInput) throw new Error("viewer requires an action (start|status|stop) and a workspace path");
        const root = resolve(workspaceInput);
        if (action === "start") {
          const workspace = await resumeWorkspace(root);
          if (workspace.state.mirrorOfRun) {
            // Mechanical ask-first boundary (§19/closure §9.F5): a trusted-run viewer start
            // is a user approval executed by the trusted broker's human/admin channel.
            throw new Error(`viewer start for trusted run ${workspace.state.mirrorOfRun.mirrorOfRun} requires explicit human approval through the broker admin channel (approve-viewer-start); the builder cannot start it`);
          }
          const portOption = parsed.options.port ? (parsed.options.port === "auto" ? "auto" as const : Number(parsed.options.port)) : undefined;
          if (portOption !== undefined && portOption !== "auto" && !Number.isInteger(portOption)) throw new Error("--port must be an integer or auto");
          const result = await startViewer(root, { ...(portOption !== undefined ? { port: portOption } : {}) });
          io.stdout(json({ status: result.status, workspace: root, url: result.url, host: result.host, port: result.port, pid: result.pid, candidateHash: workspace.state.candidateHash, model: workspace.project.model }));
          return 0;
        }
        if (action === "status") {
          const result = await viewerStatus(root);
          io.stdout(json(result.status === "running"
            ? { status: "running", url: result.record.url, host: result.record.host, port: result.record.port, pid: result.record.pid }
            : result.status === "stale-record"
              ? { status: "stale-record", detail: "runtime metadata exists but the server is not answering; the next start recreates it" }
              : { status: "not-running" }));
          return 0;
        }
        if (action === "stop") {
          const result = await stopViewer(root);
          if (result.status === "stopped") io.stdout(json({ status: "stopped" }));
          else if (result.status === "stale-record-cleared") io.stdout(json({ status: "stale-record-cleared" }));
          else io.stdout(json({ status: "not-running" }));
          return 0;
        }
        throw new Error(`unknown viewer action: ${action} (expected start, status, or stop)`);
      }
      case "workorders": {
        const inputPath = parsed.positional[0];
        if (!inputPath) throw new Error("workorders requires a workspace or evaluation report path");
        const workspace = await optionalWorkspace(inputPath);
        const reportPath = workspace ? await latestSequentialFile(workspace.layout.internal.reports, "gate") : resolve(inputPath);
        const phase = parsed.options.phase ?? workspace?.state.activePhase;
        if (!phase) throw new Error("workorders report mode requires --phase");
        const report = JSON.parse(await readFile(reportPath, "utf8")) as { deterministic?: { workorders?: unknown[] }; style?: { workorders?: unknown[] }; workorders?: unknown[] };
        const workorders = [...(report.workorders ?? []), ...(report.deterministic?.workorders ?? []), ...(report.style?.workorders ?? [])] as Parameters<typeof selectRepairGroup>[0];
        io.stdout(json({ phase, report: storedArtifactPath(reportPath, workspace?.root), workorders: selectRepairGroup(workorders, phase) }));
        return 0;
      }
      case "replay-gates": {
        const path = parsed.positional[0];
        if (!path) throw new Error("replay-gates requires a packet path");
        const packet = JSON.parse(await readFile(resolve(path), "utf8")) as DeterministicReplayPacket;
        const verdict = replayDeterministicRows(packet);
        const rendered = `${json(verdict)}\n`;
        if (parsed.options.out) await writeFile(resolve(parsed.options.out), rendered);
        io.stdout(rendered.trimEnd());
        return verdict.passed ? 0 : 5;
      }
      case "finalize": {
        // Trusted finalization is fail-closed (§17): certification requires a trusted run
        // authority record, a fresh trusted global replay, current human approval, and a
        // trusted-isolated candidate sandbox. Bare STATE.json and ordinary development
        // workspaces can never certify — historical passed fields are provenance only.
        const path = parsed.positional[0];
        if (!path) throw new Error("finalize requires a workspace or state path");
        const target = await resolveStateTarget(path);
        if (!target.workspaceRoot) {
          io.stderr("TRUSTED_CERTIFICATION_UNAVAILABLE: bare-state finalize is development-only and cannot certify; trusted certification requires a trusted run authority");
          return 6;
        }
        const workspace = await resumeWorkspace(target.workspaceRoot);
        if (workspace.state.mirrorOfRun) {
          io.stderr(`workspace is bound to trusted run ${workspace.state.mirrorOfRun.mirrorOfRun}; certification is executed by the trusted broker (human/admin capability), not this builder-invoked CLI`);
          return 7;
        }
        if (workspace.project.oracle) await verifyWorkspaceOraclePreparation(workspace);
        const execution = await inspectWorkspaceCandidateViaExecutor({
          workspaceRoot: workspace.root,
          modelEntryPath: workspace.resolved.model,
          boundaryRoot: resolve(workspace.root, "model"),
          poses: [neutralPoseForProfile(workspace.project.profile)],
          auditOptions: await trustedGeneratedAuditOptions(workspace),
        });
        if (execution.candidateHash !== workspace.state.candidateHash) throw new Error("current workspace candidate differs from gated/reviewed candidate; rerun gate and review");
        try {
          const certified = await certifyStateFromArtifacts(await loadTaskState(target.statePath), target.workspaceRoot);
          void certified;
        } catch (error) {
          io.stderr(`certification checks failed: ${error instanceof Error ? error.message : String(error)}`);
          return 2;
        }
        io.stderr("TRUSTED_CERTIFICATION_UNAVAILABLE: development/untrusted reconstruction cannot claim certification; create a trusted run through the broker with human approval to certify");
        return 6;
      }
      default:
        io.stderr(`unknown command: ${command}\n${HELP}`);
        return 2;
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}

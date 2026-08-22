#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditCandidateModule, loadCandidateRuntime } from "./core/candidate.js";
import { replayDeterministicRows, type DeterministicReplayPacket } from "./core/replay.js";
import { evaluateCandidateWithPoses, type PosedEvaluationBundle } from "./core/orchestration.js";
import { loadPreparedOracle, onboardOracle, probeGlb, repairPreparedOracle, verifyOracleRegistration, type OnboardOracleInput, type OracleManifest, type RegistrationExpectation, type RepairPreparedOracleInput } from "./core/oracle.js";
import { routeSubject } from "./core/routing.js";
import { acceptPhase, bindCandidate, bindCandidatePhases, bindEvidenceConfig, bindOracle, certifyStateFromArtifacts, createRenderEvidenceArtifact, createRuntimeEvaluationEvidenceArtifact, createRuntimeGateEvidenceArtifact, createWorkflowGateEvidenceArtifact, determineNextAction, isAuthoritativeEvidence, loadTaskState, recordAttempt, recordEvidenceArtifact, reopenPhase, saveTaskState, setAuthoritativeDimensionStatus, verifyEvidenceArtifact, type EvidenceArtifact, type EvidenceRecord } from "./core/state.js";
import { createWorkspaceResolver, initializeWorkspace, migrateWorkspace, resolveStateTarget, resumeWorkspace } from "./core/workspace.js";
import type { ProfileId } from "./types.js";
import { validateOracleManifest } from "./core/schema.js";
import { canonicalJson, fingerprintScene, sha256 } from "./core/hashing.js";
import { getProfileContract } from "./core/contracts.js";
import { inspectAllUpstreamDrift } from "./core/upstream.js";
import type { GenericSubjectContract } from "./profiles/generic.js";
import { awaitingVisualReview, createVisualReviewPacket, verifyVisualReviewPacketFiles, verifyVisualReviewVerdict, type ReviewFileReference, type VisualReviewPacket, type VisualReviewVerdict } from "./core/review.js";
import { snapshotScene } from "./core/geometry.js";
import { measureBounds } from "./core/measurement.js";
import { compareRegionDiagnostics, createComparisonBoard, createTurntable, deriveCanonicalFrame, standardRenderProfile, writeCapturePng } from "./core/render.js";
import type { CapturePass } from "./types.js";
import { selectRepairGroup } from "./core/compare.js";
import { renderCapture, type RenderBackend } from "./core/three-render.js";

interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

function parseOptions(args: string[]): { positional: string[]; options: Record<string, string>; optionValues: Record<string, string[]> } {
  const positional: string[] = [];
  const options: Record<string, string> = {};
  const optionValues: Record<string, string[]> = {};
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
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`option ${value} requires a value`);
    const key = value.slice(2);
    options[key] = next;
    (optionValues[key] ??= []).push(next);
    index += 1;
  }
  return { positional, options, optionValues };
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

async function optionalWorkspace(input: string): Promise<Awaited<ReturnType<typeof resumeWorkspace>> | undefined> {
  const absolute = resolve(input);
  let info;
  try { info = await stat(absolute); } catch { return undefined; }
  const canonicalState = basename(absolute) === "state.json" && basename(dirname(absolute)) === ".mesh2threejs";
  if (info.isDirectory() || basename(absolute) === "project.json" || canonicalState) return resumeWorkspace(absolute);
  return undefined;
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
  init WORKSPACE --id ID --goal TEXT --profile tank|generic [--ref PATH ...] [--oracle GLB] [--reference-mode copy|external]
  migrate WORKSPACE [--oracle GLB] [--reference-mode copy|external]
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
  register --manifest manifest.json --config expectation.json [--out evidence.json]
  audit-candidate MODULE
  gate WORKSPACE
  gate --oracle manifest.json --candidate MODULE --profile tank|generic [--out report.json]
  render WORKSPACE
  render --oracle manifest.json --candidate MODULE --out-dir DIR
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
        const { statePath } = await resolveStateTarget(path);
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
        const { statePath } = await resolveStateTarget(path);
        const state = bindEvidenceConfig(await loadTaskState(statePath), kind, required(parsed.options, "hash"), required(parsed.options, "reason"));
        await saveTaskState(statePath, state);
        io.stdout(json({ status: "config-bound", kind, configHash: state.evidenceConfigHashes[kind] }));
        return 0;
      }
      case "record-evidence": {
        const path = parsed.positional[0];
        if (!path) throw new Error("record-evidence requires a state path");
        const target = await resolveStateTarget(path);
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
        const current = await loadTaskState(statePath);
        const phase = parsed.options.phase ?? (target.workspaceRoot ? current.activePhase : undefined);
        if (!phase) throw new Error("lock state-file mode requires --phase");
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
        const { statePath } = await resolveStateTarget(path);
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
          const reviewRun = await createRunDirectory(workspace.layout.internal.visualReview, "review");
          const renderManifestPath = await latestRunFile(workspace.layout.internal.captures, "render", "render-manifest.json");
          const renderManifest = JSON.parse(await readFile(renderManifestPath, "utf8")) as { oracleHash: string; candidateHash: string; captures: Array<{ path: string; sha256: string; pass: string; cameraId: string }>; comparisonBoards: Array<{ path: string; sha256: string }>; turntable: Array<{ path: string; sha256: string }>; regionDiagnostics?: { path: string; sha256: string } };
          const state = await loadTaskState(workspace.layout.internal.state);
          if (state.oracleHash !== renderManifest.oracleHash || state.candidateHash !== renderManifest.candidateHash) throw new Error("latest render manifest is stale for the workspace state");
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
        await verifyVisualReviewPacketFiles(packet, target.workspaceRoot);
        let state = await loadTaskState(statePath);
        if (state.oracleHash !== packet.oracleHash || state.candidateHash !== packet.candidateHash || state.profileContractHash !== packet.profileContractHash) throw new Error("visual review is bound to stale state");
        const reviewSequence = Object.values(state.evidence).filter((item) => item.kind === "visual-review").length + 1;
        const artifact = createWorkflowGateEvidenceArtifact({ id: `visual-review-${String(reviewSequence).padStart(4, "0")}`, kind: "visual-review", phase: "visual-review", oracleHash: packet.oracleHash, candidateHash: packet.candidateHash, profileContractHash: packet.profileContractHash, configHash: packet.packetHash, gateCode: "visual.review", passed: verdict.verdict === "PASS", summary: `external visual review ${verdict.verdict}`, details: { packet, verdict } });
        if (state.evidenceConfigHashes["visual-review"] && state.evidenceConfigHashes["visual-review"] !== packet.packetHash) state = bindEvidenceConfig(state, "visual-review", packet.packetHash, "recording a new explicitly reviewed capture packet");
        const defaultReviewRun = !parsed.options.artifact && target.workspaceRoot ? await createRunDirectory(createWorkspaceResolver(target.workspaceRoot).layout.internal.evidence, "review") : undefined;
        const artifactPath = parsed.options.artifact ? workspacePath(parsed.options.artifact, target.workspaceRoot) : defaultReviewRun ? join(defaultReviewRun.path, "visual-review.json") : undefined;
        if (!artifactPath) throw new Error("record-review state-file mode requires --artifact");
        await mkdir(dirname(artifactPath), { recursive: true });
        await writeFile(artifactPath, `${json(artifact)}\n`, { flag: "wx" });
        state = recordEvidenceArtifact(state, storedArtifactPath(artifactPath, target.workspaceRoot), artifact);
        await saveTaskState(statePath, state);
        io.stdout(json({ status: state.visualReviewStatus, evidenceId: artifact.id }));
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
        if (workspace && !workspace.project.oracle) throw new Error("workspace has no oracle reference to onboard");
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
          const state = setAuthoritativeDimensionStatus(current, admitted ? "admitted" : "not-admitted", admitted ? manifest.dimensionSources : []);
          await saveTaskState(workspace.layout.internal.state, state);
        }
        io.stdout(json({ status: "onboarded", manifest: outputPath, sourceHash: manifest.sourceHash, preparedHash: manifest.preparedHash }));
        return 0;
      }
      case "repair-oracle": {
        const workspaceInput = parsed.positional[0] ?? parsed.options.workspace;
        const workspace = workspaceInput ? await resumeWorkspace(workspaceInput) : undefined;
        const manifestPath = workspace?.layout.internal.oracleManifest ?? resolve(required(parsed.options, "manifest"));
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as OracleManifest;
        if (!validateOracleManifest(manifest).valid) throw new Error("oracle manifest schema is invalid");
        const config = JSON.parse(await readFile(resolve(required(parsed.options, "config")), "utf8")) as RepairPreparedOracleInput;
        const repaired = await repairPreparedOracle(manifest, workspace ? {
          ...config,
          preparedPath: `.mesh2threejs/oracle/prepared-repair-${manifest.repairHistory.length + 1}.json`,
        } : config, workspace?.root);
        const outputPath = workspace?.layout.internal.oracleManifest ?? resolve(required(parsed.options, "out"));
        await writeFile(outputPath, `${json(repaired)}\n`, workspace ? undefined : { flag: "wx" });
        io.stdout(json({ status: "repaired", manifest: outputPath, sourceHash: repaired.sourceHash, preparedHash: repaired.preparedHash }));
        return 0;
      }
      case "register": {
        const workspaceInput = parsed.positional[0] ?? parsed.options.workspace;
        const workspace = workspaceInput ? await resumeWorkspace(workspaceInput) : undefined;
        const manifestPath = workspace?.layout.internal.oracleManifest ?? resolve(required(parsed.options, "manifest"));
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as OracleManifest;
        if (!validateOracleManifest(manifest).valid) throw new Error("oracle manifest schema is invalid");
        const expectation = JSON.parse(await readFile(resolve(required(parsed.options, "config")), "utf8")) as RegistrationExpectation;
        const oracle = await loadPreparedOracle(manifest, workspace?.root);
        const evidence = verifyOracleRegistration(oracle, expectation);
        const rendered = `${json(evidence)}\n`;
        const registrationRun = workspace ? await createRunDirectory(workspace.layout.internal.evidence, "registration") : undefined;
        const reportPath = registrationRun ? join(workspace!.layout.internal.reports, `${registrationRun.id}.json`) : (parsed.options.out ? resolve(parsed.options.out) : undefined);
        if (reportPath) { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, rendered, { flag: "wx" }); }
        const stateOption = workspace?.layout.internal.state ?? parsed.options.state;
        const artifactOption = registrationRun ? join(registrationRun.path, "registration.json") : parsed.options.artifact;
        if (stateOption || artifactOption) {
          if (!stateOption || !artifactOption) throw new Error("registration state recording requires both --state and --artifact");
          const statePath = resolve(stateOption);
          let state = bindOracle(await loadTaskState(statePath), fingerprintScene(oracle));
          const artifact = createWorkflowGateEvidenceArtifact({ id: registrationRun?.id ?? "registration", kind: "registration", phase: "oracle-registration", oracleHash: state.oracleHash!, candidateHash: null, profileContractHash: state.profileContractHash, configHash: sha256(canonicalJson(expectation)), gateCode: "registration.complete", passed: evidence.passed, summary: evidence.passed ? "reference registration passed" : "reference registration failed", details: evidence });
          const artifactPath = resolve(artifactOption);
          await mkdir(dirname(artifactPath), { recursive: true });
          await writeFile(artifactPath, `${json(artifact)}\n`, { flag: "wx" });
          state = recordEvidenceArtifact(state, storedArtifactPath(artifactPath, workspace?.root), artifact);
          await saveTaskState(statePath, state);
        }
        io.stdout(rendered.trimEnd());
        return evidence.passed ? 0 : 4;
      }
      case "audit-candidate": {
        const path = parsed.positional[0];
        if (!path) throw new Error("audit-candidate requires a module path");
        const result = await auditCandidateModule(resolve(path));
        io.stdout(json(result));
        return result.passed ? 0 : 3;
      }
      case "gate": {
        const workspaceInput = parsed.positional[0] ?? parsed.options.workspace;
        const workspace = workspaceInput ? await resumeWorkspace(workspaceInput) : undefined;
        const manifestPath = workspace?.layout.internal.oracleManifest ?? resolve(required(parsed.options, "oracle"));
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as OracleManifest;
        if (!validateOracleManifest(manifest).valid) throw new Error("oracle manifest schema is invalid");
        const profile = (workspace?.project.profile ?? required(parsed.options, "profile")) as ProfileId;
        if (profile !== "tank" && profile !== "generic") throw new Error("--profile must be tank or generic");
        const subjectContractPath = workspace?.resolved.subjectContract ?? (parsed.options["subject-contract"] ? resolve(parsed.options["subject-contract"]) : undefined);
        const subjectContract = subjectContractPath ? JSON.parse(await readFile(subjectContractPath, "utf8")) as GenericSubjectContract : undefined;
        const candidatePath = workspace?.resolved.model ?? resolve(required(parsed.options, "candidate"));
        const audit = await auditCandidateModule(candidatePath);
        if (!audit.passed) throw new Error(`candidate source audit failed: ${audit.findings.map((finding) => finding.code).join(", ")}`);
        const candidateFiles = await Promise.all(audit.files.map(async (path) => {
          const info = await stat(path);
          return { path: workspace ? relative(workspace.root, path).replaceAll("\\", "/") : path, size: info.size, modifiedMs: Math.trunc(info.mtimeMs) };
        }));
        const certification = workspace?.state.certification ?? (manifest.authoritativeDimensions ? "exact-real" : "oracle-relative");
        const cacheIdentity = { schemaVersion: 1, evaluatorVersion: 3, preparedHash: manifest.preparedHash, profile, profileContractHash: workspace?.state.profileContractHash ?? null, certification, subjectContract: subjectContract ?? null, authoritativeDimensions: manifest.authoritativeDimensions, candidateFiles };
        const cachePath = workspace ? join(workspace.layout.internal.reports, "gate-cache.json") : undefined;
        let evaluation: PosedEvaluationBundle | undefined;
        if (cachePath) {
          try {
            const cached = JSON.parse(await readFile(cachePath, "utf8")) as { identity?: unknown; evaluation?: PosedEvaluationBundle };
            if (canonicalJson(cached.identity) === canonicalJson(cacheIdentity)) evaluation = cached.evaluation;
          } catch { /* cache miss or incomplete cache */ }
        }
        if (!evaluation) {
          const candidate = await loadCandidateRuntime(candidatePath);
          const oracle = await loadPreparedOracle(manifest, workspace?.root);
          evaluation = await evaluateCandidateWithPoses({
            oracle,
            candidate,
            profile,
            certification,
            ...(subjectContract ? { subjectContract } : {}),
            ...(manifest.authoritativeDimensions ? { authoritativeDimensions: manifest.authoritativeDimensions } : {}),
          });
          if (cachePath) {
            const temporary = `${cachePath}.${process.pid}.tmp`;
            await writeFile(temporary, `${json({ identity: cacheIdentity, evaluation })}\n`, { flag: "wx" });
            await rename(temporary, cachePath);
          }
        }
        const rendered = `${json(evaluation)}\n`;
        const workspaceGateRun = workspace ? await createRunDirectory(workspace.layout.internal.evidence, "gate") : undefined;
        const reportPath = workspaceGateRun ? join(workspace!.layout.internal.reports, `${workspaceGateRun.id}.json`) : (parsed.options.out ? resolve(parsed.options.out) : undefined);
        if (reportPath) { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, rendered, { flag: "wx" }); }
        const stateOption = workspace?.layout.internal.state ?? parsed.options.state;
        const artifactOption = workspace?.layout.internal.evidence ?? parsed.options["artifact-dir"];
        if (stateOption || artifactOption) {
          if (!stateOption || !artifactOption) throw new Error("gate state recording requires both --state and --artifact-dir");
          const statePath = resolve(stateOption);
          let state = await loadTaskState(statePath);
          state = bindOracle(state, evaluation.oracleHash);
          state = bindCandidatePhases(state, evaluation.candidateHash, evaluation.phaseGeometryHashes);
          const parentDirectory = resolve(artifactOption);
          const run = workspaceGateRun ?? await createRunDirectory(parentDirectory, "gate");
          const directory = run.path;
          const configHash = sha256(canonicalJson({ profile, subjectContract: subjectContract ?? null, preparedHash: manifest.preparedHash }));
          const complexityRows = evaluation.style.rows.filter((row) => row.code.startsWith("style.complexity"));
          const complexityReport = { profile, passed: complexityRows.every((row) => row.passed), score: complexityRows.length ? Math.min(...complexityRows.map((row) => row.score)) : 0, rows: complexityRows, workorders: evaluation.style.workorders.filter((item) => item.errorKind.startsWith("style.complexity")) };
          const artifacts = [
            ...Object.entries(evaluation.phaseGates).map(([phase, report]) => createRuntimeGateEvidenceArtifact({ id: `${run.id}-${phase}`, phase, oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: state.profileContractHash, configHash, report })),
            createRuntimeEvaluationEvidenceArtifact({ id: `${run.id}-style`, kind: "style", phase: profile === "tank" ? "style-fabrication" : "style-complexity", oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: state.profileContractHash, configHash, report: evaluation.style }),
            createRuntimeEvaluationEvidenceArtifact({ id: `${run.id}-complexity`, kind: "complexity", phase: profile === "tank" ? "style-fabrication" : "style-complexity", oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: state.profileContractHash, configHash, report: complexityReport }),
            ...(evaluation.articulation.rows.length ? [createRuntimeEvaluationEvidenceArtifact({ id: `${run.id}-articulation`, kind: "articulation", phase: evaluation.articulation.rows[0]!.phase ?? (profile === "tank" ? "fittings-articulation" : "attachments"), oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: state.profileContractHash, configHash, report: evaluation.articulation })] : []),
          ];
          for (const artifact of artifacts) {
            const artifactPath = join(directory, `${artifact.id}.json`);
            await writeFile(artifactPath, `${json(artifact)}\n`, { flag: "wx" });
            state = recordEvidenceArtifact(state, storedArtifactPath(artifactPath, workspace?.root), artifact);
          }
          await saveTaskState(statePath, state);
        }
        io.stdout(rendered.trimEnd());
        return evaluation.passed ? 0 : 4;
      }
      case "render": {
        const workspaceInput = parsed.positional[0] ?? parsed.options.workspace;
        const workspace = workspaceInput ? await resumeWorkspace(workspaceInput) : undefined;
        const manifestPath = workspace?.layout.internal.oracleManifest ?? resolve(required(parsed.options, "oracle"));
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as OracleManifest;
        if (!validateOracleManifest(manifest).valid) throw new Error("oracle manifest schema is invalid");
        const oracle = await loadPreparedOracle(manifest, workspace?.root);
        const candidateRuntime = await loadCandidateRuntime(workspace?.resolved.model ?? resolve(required(parsed.options, "candidate")));
        const candidate = candidateRuntime.root;
        const oracleSnapshot = snapshotScene(oracle);
        const candidateSnapshot = snapshotScene(candidate);
        const oracleBounds = measureBounds(oracleSnapshot);
        const frame = deriveCanonicalFrame(oracleBounds, Number(parsed.options.precision ?? 0.01));
        const profile = standardRenderProfile({ width: frame.width, height: frame.height });
        profile.camera.orthographicHeight = frame.orthographicHeight;
        const renderRun = workspace ? await createRunDirectory(workspace.layout.internal.captures, "render") : undefined;
        const directory = renderRun?.path ?? resolve(required(parsed.options, "out-dir"));
        await mkdir(directory, { recursive: true });
        const passes: CapturePass[] = ["beauty", "alpha-silhouette", "semantic-id", "depth", "normal", "roughness-material-id"];
        const requestedBackend = (parsed.options.renderer ?? "auto") as RenderBackend;
        if (!["auto", "deterministic-cpu", "three-webgl"].includes(requestedBackend)) throw new Error("--renderer must be auto, deterministic-cpu, or three-webgl");
        const captures: Array<{ subject: "oracle" | "candidate"; pass: CapturePass; cameraId: string; path: string; sha256: string }> = [];
        const boards: string[] = [];
        for (const cameraId of ["side", "front", "plan"] as const) {
          for (const pass of passes) {
            const oracleRendered = renderCapture({ root: oracle, snapshot: oracleSnapshot, profile, camera: frame.cameras[cameraId], pass, backend: requestedBackend });
            const candidateRendered = renderCapture({ root: candidate, snapshot: candidateSnapshot, profile, camera: frame.cameras[cameraId], pass, backend: requestedBackend });
            const oracleFrame = oracleRendered.frame;
            const candidateFrame = candidateRendered.frame;
            const oraclePath = join(directory, `${cameraId}-oracle-${pass}.png`);
            const candidatePath = join(directory, `${cameraId}-candidate-${pass}.png`);
            await writeCapturePng(oraclePath, oracleFrame); await writeCapturePng(candidatePath, candidateFrame);
            captures.push({ subject: "oracle", pass, cameraId, path: storedArtifactPath(oraclePath, workspace?.root), sha256: sha256(await readFile(oraclePath)) }, { subject: "candidate", pass, cameraId, path: storedArtifactPath(candidatePath, workspace?.root), sha256: sha256(await readFile(candidatePath)) });
            if (pass === "beauty") { const board = join(directory, `${cameraId}-comparison.png`); await createComparisonBoard(board, oracleFrame, candidateFrame); boards.push(board); }
          }
        }
        const span = Math.max(...oracleBounds.size);
        const turntable = await createTurntable(join(directory, "turntable"), candidateSnapshot, profile, { frames: 24, radius: span * 2.5, elevation: Math.max(span * 0.35, oracleBounds.size[1] * 0.75), target: oracleBounds.center });
        const regionDiagnosticsPath = join(directory, "region-diagnostics.json");
        await writeFile(regionDiagnosticsPath, `${json({ schemaVersion: 1, rows: compareRegionDiagnostics(oracleSnapshot, candidateSnapshot, profile, [frame.cameras.side, frame.cameras.front, frame.cameras.plan]) })}\n`, { flag: "wx" });
        const regionDiagnostics = { path: storedArtifactPath(regionDiagnosticsPath, workspace?.root), sha256: sha256(await readFile(regionDiagnosticsPath)) };
        const neutralSceneHash = fingerprintScene(candidate);
        const actualBackend = requestedBackend === "three-webgl" ? "three-webgl" : "deterministic-cpu";
        const renderManifest = { schemaVersion: 1, kind: `${actualBackend}-render-evidence`, backend: actualBackend, oracleHash: fingerprintScene(oracle), candidateHash: candidateRuntime.sourceHash ? sha256(canonicalJson({ neutralSceneHash, sourceHash: candidateRuntime.sourceHash })) : neutralSceneHash, frame, profileHash: sha256(canonicalJson(profile)), captures, comparisonBoards: await Promise.all(boards.map(async (path) => ({ path: storedArtifactPath(path, workspace?.root), sha256: sha256(await readFile(path)) }))), turntable: await Promise.all(turntable.map(async (path) => ({ path: storedArtifactPath(path, workspace?.root), sha256: sha256(await readFile(path)) }))), regionDiagnostics };
        const outputManifestPath = join(directory, "render-manifest.json");
        await writeFile(outputManifestPath, `${json(renderManifest)}\n`, { flag: "wx" });
        if (workspace && renderRun) {
          let state = await loadTaskState(workspace.layout.internal.state);
          if (state.oracleHash !== renderManifest.oracleHash || state.candidateHash !== renderManifest.candidateHash) throw new Error("render evidence is bound to geometry that has not passed the current gate run");
          const evidenceDirectory = join(workspace.layout.internal.evidence, renderRun.id);
          await mkdir(evidenceDirectory);
          const configHash = sha256(canonicalJson({ frame: frame.frameHash, profile: renderManifest.profileHash, backend: actualBackend }));
          const artifact = createRenderEvidenceArtifact({ id: `${renderRun.id}-turntable`, phase: "visual-review", oracleHash: renderManifest.oracleHash, candidateHash: renderManifest.candidateHash, profileContractHash: state.profileContractHash, configHash, manifest: renderManifest });
          const artifactPath = join(evidenceDirectory, "turntable.json");
          await writeFile(artifactPath, `${json(artifact)}\n`, { flag: "wx" });
          state = recordEvidenceArtifact(state, storedArtifactPath(artifactPath, workspace.root), artifact);
          await saveTaskState(workspace.layout.internal.state, state);
        }
        io.stdout(json({ status: `rendered-${actualBackend}`, manifest: outputManifestPath, captures: captures.length, turntable: turntable.length }));
        return 0;
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
        const path = parsed.positional[0];
        if (!path) throw new Error("finalize requires a workspace or state path");
        const target = await resolveStateTarget(path);
        const certified = await certifyStateFromArtifacts(await loadTaskState(target.statePath), target.workspaceRoot);
        await saveTaskState(target.statePath, certified);
        io.stdout(json({ status: certified.status, candidateHash: certified.candidateHash }));
        return 0;
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

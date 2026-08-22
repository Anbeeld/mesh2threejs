#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { auditCandidateModule, loadCandidateRuntime } from "./core/candidate.js";
import { replayDeterministicRows, type DeterministicReplayPacket } from "./core/replay.js";
import { evaluateCandidateWithPoses } from "./core/orchestration.js";
import { loadPreparedOracle, onboardOracle, probeGlb, repairPreparedOracle, verifyOracleRegistration, type OnboardOracleInput, type OracleManifest, type RegistrationExpectation, type RepairPreparedOracleInput } from "./core/oracle.js";
import { routeSubject } from "./core/routing.js";
import { acceptPhase, bindCandidate, bindCandidatePhases, bindEvidenceConfig, bindOracle, certifyStateFromArtifacts, createEvidenceArtifact, determineNextAction, loadTaskState, recordAttempt, recordEvidenceArtifact, reopenPhase, saveTaskState, type EvidenceArtifact, type EvidenceRecord } from "./core/state.js";
import { createWorkspaceResolver, initializeWorkspace, migrateWorkspace, resolveStateTarget, resumeWorkspace } from "./core/workspace.js";
import type { ProfileId } from "./types.js";
import { validateOracleManifest } from "./core/schema.js";
import { canonicalJson, fingerprintScene, sha256 } from "./core/hashing.js";
import { inspectAllUpstreamDrift } from "./core/upstream.js";
import type { GenericSubjectContract } from "./profiles/generic.js";
import { awaitingVisualReview, createVisualReviewPacket, verifyVisualReviewVerdict, type VisualReviewPacket, type VisualReviewVerdict } from "./core/review.js";
import { snapshotScene } from "./core/geometry.js";
import { createComparisonBoard, createTurntable, deriveCanonicalFrame, rasterizeCapture, standardRenderProfile, writeCapturePng } from "./core/render.js";
import type { CapturePass } from "./types.js";
import { selectRepairGroup } from "./core/compare.js";

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

const HELP = `mesh2threejs commands:
  init WORKSPACE --id ID --goal TEXT --profile tank|generic [--ref PATH ...] [--oracle GLB] [--reference-mode copy|external]
  migrate WORKSPACE [--oracle GLB] [--reference-mode copy|external]
  status WORKSPACE|STATE.json
  next WORKSPACE|STATE.json
  bind-oracle STATE.json --hash SHA256
  bind-candidate STATE.json --hash SHA256
  bind-config STATE.json --kind KIND --hash SHA256 --reason TEXT
  record-evidence STATE.json --artifact evidence.json
  lock STATE.json --phase PHASE --geometry-hash SHA256 --evidence ID[,ID]
  reopen STATE.json --phase PHASE --reason TEXT
  attempt STATE.json --action TEXT --evidence-hash SHA256 --score NUMBER
  prepare-review CONFIG.json --out packet.json
  review-status PACKET.json
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
  workorders REPORT.json --phase PHASE
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
        const { statePath } = await resolveStateTarget(path);
        const current = await loadTaskState(statePath);
        const state = acceptPhase(current, required(parsed.options, "phase"), { geometryHash: required(parsed.options, "geometry-hash"), evidenceIds: required(parsed.options, "evidence").split(",").filter(Boolean), contractHash: current.profileContractHash });
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
        const configPath = parsed.positional[0];
        if (!configPath) throw new Error("prepare-review requires a config path");
        const config = JSON.parse(await readFile(resolve(configPath), "utf8")) as Omit<VisualReviewPacket, "schemaVersion" | "packetHash">;
        const packet = createVisualReviewPacket(config);
        const outputPath = resolve(required(parsed.options, "out"));
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, `${json(packet)}\n`, { flag: "wx" });
        io.stdout(json(awaitingVisualReview(packet)));
        return 0;
      }
      case "review-status": {
        const packetPath = parsed.positional[0];
        if (!packetPath) throw new Error("review-status requires a packet path");
        io.stdout(json(awaitingVisualReview(JSON.parse(await readFile(resolve(packetPath), "utf8")) as VisualReviewPacket)));
        return 0;
      }
      case "record-review": {
        const path = parsed.positional[0];
        if (!path) throw new Error("record-review requires a state path");
        const target = await resolveStateTarget(path);
        const statePath = target.statePath;
        const packet = JSON.parse(await readFile(workspacePath(required(parsed.options, "packet"), target.workspaceRoot), "utf8")) as VisualReviewPacket;
        const verdict = JSON.parse(await readFile(workspacePath(required(parsed.options, "verdict"), target.workspaceRoot), "utf8")) as VisualReviewVerdict;
        verifyVisualReviewVerdict(packet, verdict);
        let state = await loadTaskState(statePath);
        if (state.oracleHash !== packet.oracleHash || state.candidateHash !== packet.candidateHash || state.profileContractHash !== packet.profileContractHash) throw new Error("visual review is bound to stale state");
        const artifact = createEvidenceArtifact({ id: "visual-review", kind: "visual-review", phase: "visual-review", oracleHash: packet.oracleHash, candidateHash: packet.candidateHash, profileContractHash: packet.profileContractHash, configHash: packet.packetHash, result: { passed: verdict.verdict === "PASS", summary: `external visual review ${verdict.verdict}`, details: verdict } });
        const artifactPath = workspacePath(required(parsed.options, "artifact"), target.workspaceRoot);
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
        const reportPath = workspace ? join(workspace.layout.internal.reports, "registration.json") : (parsed.options.out ? resolve(parsed.options.out) : undefined);
        if (reportPath) { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, rendered); }
        const stateOption = workspace?.layout.internal.state ?? parsed.options.state;
        const artifactOption = workspace ? join(workspace.layout.internal.evidence, "registration.json") : parsed.options.artifact;
        if (stateOption || artifactOption) {
          if (!stateOption || !artifactOption) throw new Error("registration state recording requires both --state and --artifact");
          const statePath = resolve(stateOption);
          let state = bindOracle(await loadTaskState(statePath), fingerprintScene(oracle));
          const artifact = createEvidenceArtifact({ id: "registration", kind: "registration", phase: "oracle-registration", oracleHash: state.oracleHash!, candidateHash: null, profileContractHash: state.profileContractHash, configHash: sha256(canonicalJson(expectation)), result: { passed: evidence.passed, summary: evidence.passed ? "reference registration passed" : "reference registration failed", details: evidence } });
          const artifactPath = resolve(artifactOption);
          await mkdir(dirname(artifactPath), { recursive: true });
          await writeFile(artifactPath, `${json(artifact)}\n`, workspace ? undefined : { flag: "wx" });
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
        const candidate = await loadCandidateRuntime(workspace?.resolved.model ?? resolve(required(parsed.options, "candidate")));
        const oracle = await loadPreparedOracle(manifest, workspace?.root);
        const profile = (workspace?.project.profile ?? required(parsed.options, "profile")) as ProfileId;
        if (profile !== "tank" && profile !== "generic") throw new Error("--profile must be tank or generic");
        const subjectContractPath = workspace?.resolved.subjectContract ?? (parsed.options["subject-contract"] ? resolve(parsed.options["subject-contract"]) : undefined);
        const subjectContract = subjectContractPath ? JSON.parse(await readFile(subjectContractPath, "utf8")) as GenericSubjectContract : undefined;
        const evaluation = await evaluateCandidateWithPoses({
          oracle,
          candidate,
          profile,
          certification: manifest.authoritativeDimensions ? "exact-real" : "oracle-relative",
          ...(subjectContract ? { subjectContract } : {}),
          ...(manifest.authoritativeDimensions && "hullLength" in manifest.authoritativeDimensions
            ? { authoritativeDimensions: manifest.authoritativeDimensions as { hullLength: number; overallLength: number; width: number; height: number } }
            : {}),
        });
        const rendered = `${json(evaluation)}\n`;
        const reportPath = workspace ? join(workspace.layout.internal.reports, "evaluation.json") : (parsed.options.out ? resolve(parsed.options.out) : undefined);
        if (reportPath) { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, rendered); }
        const stateOption = workspace?.layout.internal.state ?? parsed.options.state;
        const artifactOption = workspace?.layout.internal.evidence ?? parsed.options["artifact-dir"];
        if (stateOption || artifactOption) {
          if (!stateOption || !artifactOption) throw new Error("gate state recording requires both --state and --artifact-dir");
          const statePath = resolve(stateOption);
          let state = await loadTaskState(statePath);
          state = bindOracle(state, evaluation.oracleHash);
          state = bindCandidatePhases(state, evaluation.candidateHash, evaluation.phaseGeometryHashes);
          const directory = resolve(artifactOption);
          await mkdir(directory, { recursive: true });
          const configHash = sha256(canonicalJson({ profile, subjectContract: subjectContract ?? null, preparedHash: manifest.preparedHash }));
          const artifacts = [
            createEvidenceArtifact({ id: "deterministic-gate", kind: "deterministic-gate", phase: state.activePhase, oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: state.profileContractHash, configHash, result: { passed: evaluation.deterministic.passed && evaluation.contractGates.passed, summary: `deterministic score ${evaluation.deterministic.score}; contract score ${evaluation.contractGates.score}`, details: { deterministic: evaluation.deterministic, contractGates: evaluation.contractGates } } }),
            createEvidenceArtifact({ id: "style", kind: "style", phase: profile === "tank" ? "style-fabrication" : "style-complexity", oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: state.profileContractHash, configHash, result: { passed: evaluation.style.passed, summary: `style score ${evaluation.style.score}`, details: evaluation.style } }),
            createEvidenceArtifact({ id: "complexity", kind: "complexity", phase: profile === "tank" ? "style-fabrication" : "style-complexity", oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: state.profileContractHash, configHash, result: { passed: evaluation.style.rows.filter((row) => row.code.startsWith("style.complexity")).every((row) => row.passed), summary: "complexity rows derived from style report", details: evaluation.style.rows.filter((row) => row.code.startsWith("style.complexity")) } }),
            createEvidenceArtifact({ id: "articulation", kind: "articulation", phase: profile === "tank" ? "fittings-articulation" : "attachments", oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash, profileContractHash: state.profileContractHash, configHash, result: { passed: evaluation.articulation.passed, summary: `sampled articulation score ${evaluation.articulation.score}`, details: evaluation.articulation } }),
          ];
          for (const artifact of artifacts) {
            const artifactPath = join(directory, `${artifact.id}.json`);
            await writeFile(artifactPath, `${json(artifact)}\n`, workspace ? undefined : { flag: "wx" });
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
        const frame = deriveCanonicalFrame(oracleSnapshot.components.hull?.bounds ?? Object.values(oracleSnapshot.components)[0]?.bounds ?? { min: [-1, -1, -1], max: [1, 1, 1], size: [2, 2, 2], center: [0, 0, 0] }, Number(parsed.options.precision ?? 0.01));
        const profile = standardRenderProfile({ width: frame.width, height: frame.height });
        profile.camera.orthographicHeight = frame.orthographicHeight;
        const directory = workspace?.layout.internal.captures ?? resolve(required(parsed.options, "out-dir"));
        await mkdir(directory, { recursive: true });
        const passes: CapturePass[] = ["beauty", "alpha-silhouette", "semantic-id", "depth", "normal", "roughness-material-id"];
        const captures: Array<{ subject: "oracle" | "candidate"; pass: CapturePass; cameraId: string; path: string; sha256: string }> = [];
        const boards: string[] = [];
        for (const cameraId of ["side", "front", "plan"] as const) {
          for (const pass of passes) {
            const oracleFrame = rasterizeCapture(oracleSnapshot, profile, frame.cameras[cameraId], pass);
            const candidateFrame = rasterizeCapture(candidateSnapshot, profile, frame.cameras[cameraId], pass);
            const oraclePath = join(directory, `${cameraId}-oracle-${pass}.png`);
            const candidatePath = join(directory, `${cameraId}-candidate-${pass}.png`);
            await writeCapturePng(oraclePath, oracleFrame); await writeCapturePng(candidatePath, candidateFrame);
            captures.push({ subject: "oracle", pass, cameraId, path: storedArtifactPath(oraclePath, workspace?.root), sha256: sha256(await readFile(oraclePath)) }, { subject: "candidate", pass, cameraId, path: storedArtifactPath(candidatePath, workspace?.root), sha256: sha256(await readFile(candidatePath)) });
            if (pass === "beauty") { const board = join(directory, `${cameraId}-comparison.png`); await createComparisonBoard(board, oracleFrame, candidateFrame); boards.push(board); }
          }
        }
        const turntable = await createTurntable(join(directory, "turntable"), candidateSnapshot, profile, { frames: 24, radius: Math.max(...Object.values(oracleSnapshot.components).map((component) => Math.max(...component.bounds.size))) * 2.5 });
        const neutralSceneHash = fingerprintScene(candidate);
        const renderManifest = { schemaVersion: 1, kind: "deterministic-cpu-render-evidence", oracleHash: fingerprintScene(oracle), candidateHash: candidateRuntime.sourceHash ? sha256(canonicalJson({ neutralSceneHash, sourceHash: candidateRuntime.sourceHash })) : neutralSceneHash, frame, profileHash: sha256(canonicalJson(profile)), captures, comparisonBoards: await Promise.all(boards.map(async (path) => ({ path: storedArtifactPath(path, workspace?.root), sha256: sha256(await readFile(path)) }))), turntable: await Promise.all(turntable.map(async (path) => ({ path: storedArtifactPath(path, workspace?.root), sha256: sha256(await readFile(path)) }))) };
        const outputManifestPath = join(directory, "render-manifest.json");
        await writeFile(outputManifestPath, `${json(renderManifest)}\n`, workspace ? undefined : { flag: "wx" });
        io.stdout(json({ status: "rendered-deterministic-cpu", manifest: outputManifestPath, captures: captures.length, turntable: turntable.length }));
        return 0;
      }
      case "workorders": {
        const reportPath = parsed.positional[0];
        if (!reportPath) throw new Error("workorders requires an evaluation report path");
        const report = JSON.parse(await readFile(resolve(reportPath), "utf8")) as { deterministic?: { workorders?: unknown[] }; style?: { workorders?: unknown[] }; workorders?: unknown[] };
        const workorders = [...(report.workorders ?? []), ...(report.deterministic?.workorders ?? []), ...(report.style?.workorders ?? [])] as Parameters<typeof selectRepairGroup>[0];
        io.stdout(json({ phase: required(parsed.options, "phase"), workorders: selectRepairGroup(workorders, required(parsed.options, "phase")) }));
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

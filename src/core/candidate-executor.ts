import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { CandidateModuleAudit } from "./candidate.js";
import { auditCandidateModule, stageCandidateGraph } from "./candidate.js";
import { deserializeScene, serializedSceneHash, type SerializedScene } from "./scene-serialization.js";
import { DEFAULT_EXECUTION_LIMITS, type CandidateExecutionLimits, type SandboxBackend, type SandboxSample } from "./candidate-sandbox.js";

/**
 * The one authoritative candidate-execution path. Every consumer that needs the evaluated
 * scene (gates, renders, viewer artifacts, phase hashing, replay/finalization) requests it
 * here; no untrusted runtime object or live untrusted `setPose` crosses into the trusted
 * parent process — consumers receive serialized scenes reconstructed by trusted code.
 */

export interface CandidateExecutionRequest {
  entryPath: string;
  poses: Array<Record<string, number>>;
  limits?: Partial<CandidateExecutionLimits>;
}

export interface CandidateExecutionSample extends SandboxSample {
  sceneHash: string;
}

export interface CandidateExecutionResult {
  audit: CandidateModuleAudit;
  sourceHash: string;
  isolation: string;
  samples: CandidateExecutionSample[];
  /** True when an independent repeated execution produced identical output hashes. */
  deterministic: boolean;
}

export interface ExecutorOptions {
  backend: SandboxBackend;
  limits?: Partial<CandidateExecutionLimits>;
  auditOptions?: Parameters<typeof auditCandidateModule>[1];
}

export async function executeCandidate(request: CandidateExecutionRequest, options: ExecutorOptions): Promise<CandidateExecutionResult> {
  const limits: CandidateExecutionLimits = { ...DEFAULT_EXECUTION_LIMITS, ...options.limits };
  const audit = await auditCandidateModule(request.entryPath, options.auditOptions);
  if (!audit.passed) throw new Error(`candidate source audit failed: ${audit.findings.map((finding) => finding.code).join(", ")}`);
  const stage = await stageCandidateGraph(request.entryPath, audit);
  try {
    const execute = async (): Promise<SandboxSample[]> =>
      (await options.backend.execute({ stageRoot: stage.root, entryPath: stage.entry, poses: request.poses, limits })).samples;
    const samples = await execute();
    if (samples.length !== request.poses.length) throw new Error("sandbox returned an unexpected sample count");
    let deterministic = true;
    if (request.poses.length > 0) {
      const repeat = await execute();
      const hash = (list: SandboxSample[]): string[] => list.map((sample) => serializedSceneHash(sample.serialization));
      deterministic = JSON.stringify(hash(samples)) === JSON.stringify(hash(repeat));
    }
    return {
      audit,
      sourceHash: audit.sourceHash,
      isolation: options.backend.isolation,
      samples: samples.map((sample) => ({ ...sample, sceneHash: serializedSceneHash(sample.serialization) })),
      deterministic,
    };
  } finally {
    await rm(stage.root, { recursive: true, force: true });
  }
}

/** Reconstructs trusted Object3D roots from executor samples for downstream evaluation/rendering. */
export function deserializeSamples(samples: ReadonlyArray<{ pose: Record<string, number>; serialization: SerializedScene }>): Array<{ pose: Record<string, number>; root: ReturnType<typeof deserializeScene> }> {
  return samples.map((sample) => ({ pose: sample.pose, root: deserializeScene(sample.serialization) }));
}

export function stageDirectoryMarker(): string {
  return join(".mesh2threejs-candidate-");
}

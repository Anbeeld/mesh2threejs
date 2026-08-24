import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CandidateModuleAudit } from "./candidate.js";
import { auditCandidateModule, stageCandidateGraph } from "./candidate.js";
import { deserializeScene, serializedSceneHash, type SerializedScene } from "./scene-serialization.js";
import { DEFAULT_EXECUTION_LIMITS, type CandidateExecutionLimits, type SandboxBackend, type SandboxSample } from "./candidate-sandbox.js";
import { establishExecutableGraphAuthority, type DerivedGraphExpectations, type ExecutableGraphAuthority } from "./exec-authority.js";

/**
 * The one authoritative candidate-execution path (remaining closure §2). Every consumer
 * that needs the evaluated scene requests it here. For trusted derived runs the exact
 * executable-graph authority is established from audited BYTES before anything is staged or
 * imported; the graph is then staged from that hash ledger with per-file re-hashing, and
 * only then executed outside the caller's process.
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
  isolation: import("./candidate-sandbox.js").CandidateIsolation;
  /** Pre-execution authority ledger established inside this boundary (never caller-submitted). */
  graphAuthority: ExecutableGraphAuthority;
  samples: CandidateExecutionSample[];
  /** True when an independent repeated execution produced identical output hashes. */
  deterministic: boolean;
}

export interface ExecutorOptions {
  backend: SandboxBackend;
  limits?: Partial<CandidateExecutionLimits>;
  auditOptions?: Parameters<typeof auditCandidateModule>[1];
  /**
    * Derived byte expectations computed by trusted code from canonical run state. When
    * present, execution is refused unless every audited file matches the expected pipeline
    * bytes exactly — BEFORE any import occurs.
    */
  authorityExpectations?: DerivedGraphExpectations;
}

export async function executeCandidate(request: CandidateExecutionRequest, options: ExecutorOptions): Promise<CandidateExecutionResult> {
  const limits: CandidateExecutionLimits = { ...DEFAULT_EXECUTION_LIMITS, ...options.limits };
  const audit = await auditCandidateModule(request.entryPath, options.auditOptions);
  if (!audit.passed) throw new Error(`candidate source audit failed: ${audit.findings.map((finding) => finding.code).join(", ")}`);
  // Pre-execution authority establishment (§2 sequence): classify from exact bytes BEFORE
  // staging/importing anything.
  const hashByAbsolute = new Map(audit.candidateFiles.map((file) => [resolve(dirname(resolve(request.entryPath)), file.path), file.sha256]));
  const graphAuthority = establishExecutableGraphAuthority({
    entryPath: request.entryPath,
    sourceHash: audit.sourceHash,
    files: audit.files,
    hashByAbsolute,
    trustedGeneratedModules: audit.trustedGeneratedModules,
    ...(options.authorityExpectations ? { expectations: options.authorityExpectations } : {}),
    backendIsolation: options.backend.isolation,
    backendIdentityHash: options.backend.identityHash ?? `unidentified:${options.backend.name}`,
  });
  const stage = await stageCandidateGraph(request.entryPath, audit);
  try {
    for (const file of graphAuthority.files) {
      const staged = stage.stagedFiles.find((item) => resolve(item.absolutePath) === resolve(file.absolutePath));
      if (!staged) throw new Error("CANDIDATE_CHANGED_DURING_AUTHORIZATION: audited file vanished between authority establishment and staging");
      file.stagedPath = staged.stagedPath;
    }
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
      graphAuthority,
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
  return ".mesh2threejs-candidate-";
}

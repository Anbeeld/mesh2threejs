import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import * as THREE from "three";
import type { ProfileId } from "../types.js";
import { auditCandidateModule, stageCandidateGraph } from "./candidate.js";
import { MODEL_DERIVED_SCAFFOLD } from "./derivation.js";
import { deserializeScene } from "./scene-serialization.js";
import type { CandidateExecutionResult } from "./candidate-executor.js";
import type { SandboxBackend } from "./candidate-sandbox.js";

/**
 * Executes the WORKSPACE candidate (or a trial derived composition) through the one trusted
 * sandbox path. Derived-mode tier evaluation stages the exact composition the pipeline
 * owns — canonical scaffold entry, generated registry, generated seeds, audited repairs —
 * so tier selection can never bypass the boundary normal candidate gates use (§9).
 */

export interface WorkspaceExecutionRequest {
  /** Workspace root; used for provenance and scratch placement, not for confinement. */
  workspaceRoot?: string;
  /** Absolute path of the candidate entry to execute. */
  modelEntryPath: string;
  /** Confinement root for the audit graph (the workspace model directory). */
  boundaryRoot?: string;
  poses: Array<Record<string, number>>;
  auditOptions?: Parameters<typeof auditCandidateModule>[1];
  backend: SandboxBackend;
}

export async function executeWorkspaceModel(request: WorkspaceExecutionRequest): Promise<CandidateExecutionResult> {
  const { executeCandidate } = await import("./candidate-executor.js");
  const { developmentInProcessBackend } = await import("./dev-sandbox.js");
  return executeCandidate({
    entryPath: request.modelEntryPath,
    poses: request.poses,
  }, {
    backend: request.backend ?? developmentInProcessBackend(),
    auditOptions: {
      ...(request.auditOptions ?? {}),
      ...(request.boundaryRoot !== undefined ? { boundaryRoot: request.boundaryRoot } : {}),
    },
  });
}

export interface ComposedTrialRequest {
  workspaceRoot: string;
  scratchRoot: string;
  profile: ProfileId;
  poses: Array<Record<string, number>>;
  auditOptions?: Parameters<typeof auditCandidateModule>[1];
  backend?: SandboxBackend;
}

/**
 * Stages a trial derived composition (current generated modules + repairs under the
 * pipeline-owned canonical entry) into an isolated scratch directory and executes it
 * through the same sandbox backend as ordinary candidates.
 */
export async function executeComposedDerivedTrial(request: ComposedTrialRequest): Promise<{ result: CandidateExecutionResult; cleanup: () => Promise<void>; entryPath: string }> {
  const trialRoot = await mkdtemp(join(resolve(request.scratchRoot), "composed-"));
  const modelDirectory = join(trialRoot, "model");
  try {
    await mkdir(join(modelDirectory, ".generated"), { recursive: true });
    await mkdir(join(modelDirectory, "repairs"), { recursive: true });
    await writeFile(join(modelDirectory, "model.mjs"), MODEL_DERIVED_SCAFFOLD);
    // Copy the CURRENT pipeline-owned composition layer exactly as it would execute.
    const generatedSource = resolve(request.workspaceRoot, "model", ".generated");
    try {
      await cp(generatedSource, join(modelDirectory, ".generated"), { recursive: true });
    } catch { /* no generated modules yet */ }
    const repairsSource = resolve(request.workspaceRoot, "model", "repairs");
    try {
      await cp(repairsSource, join(modelDirectory, "repairs"), { recursive: true });
    } catch { /* no repairs present */ }
    const entryPath = join(modelDirectory, "model.mjs");
    // Remap trusted generated-module authority from the ORIGINAL workspace layout to the
    // staged trial copy so dense seed modules stay waived inside the sandbox audit.
    const workspaceModelRoot = resolve(request.workspaceRoot, "model");
    const originalTrusted = (request.auditOptions?.trustedGeneratedModules ?? new Map<string, unknown>()) as ReadonlyMap<string, unknown>;
    const remappedTrusted = new Map<string, unknown>();
    for (const [absolutePath, value] of originalTrusted) {
      const relation = relative(workspaceModelRoot, resolve(absolutePath));
      if (!relation || relation.startsWith("..")) continue;
      remappedTrusted.set(resolve(join(modelDirectory, relation)), value);
    }
    const { executeCandidate } = await import("./candidate-executor.js");
    const { developmentInProcessBackend } = await import("./dev-sandbox.js");
    const result = await executeCandidate({
      entryPath,
      poses: request.poses,
    }, {
      backend: request.backend ?? developmentInProcessBackend(),
      auditOptions: {
        trustedGeneratedModules: remappedTrusted,
        boundaryRoot: modelDirectory,
      },
    });
    return {
      result,
      entryPath,
      cleanup: async () => {
        await rm(trialRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(trialRoot, { recursive: true, force: true });
    throw error;
  }
}

export interface DeserializedSamples {
  neutralRoot: THREE.Object3D;
  posedRoots: Array<{ pose: Record<string, number>; root: THREE.Object3D }>;
}

/** Reconstructs trusted roots from an execution result; sample 0 is the neutral pose. */
export function deserializeExecutionSamples(result: CandidateExecutionResult): DeserializedSamples {
  if (!result.samples.length) throw new Error("execution produced no pose samples");
  const [neutral, ...rest] = result.samples;
  return {
    neutralRoot: deserializeScene(neutral!.serialization),
    posedRoots: rest.map((sample) => ({ pose: sample.pose, root: deserializeScene(sample.serialization) })),
  };
}

/** Reads the current pipeline-owned registry module bytes for lineage checks. */
export async function readRegistryBytes(workspaceRoot: string): Promise<string | null> {
  try {
    return await readFile(resolve(workspaceRoot, "model", ".generated", "registry.mjs"), "utf8");
  } catch {
    return null;
  }
}

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertRoutePermission,
  acceptPhase,
  bindCandidate,
  bindCandidatePhases,
  bindOracle,
  certifyState,
  createEvidenceArtifact,
  createTaskState,
  loadTaskState,
  loadProfileContract,
  profileContractHash,
  determineNextAction,
  recordAttempt,
  recordEvidence,
  recordEvidenceArtifact,
  routeSubject,
  saveTaskState,
  setAuthoritativeDimensionStatus,
  skipPhase,
  transitionRoute,
} from "../src/index.js";

describe("durable workflow state", () => {
  test("requires evidence and rejects out-of-order certification", () => {
    const state = createTaskState({ taskId: "x", profile: "generic", style: "low-poly-faithful" });
    expect(() => transitionRoute(state, "finalize")).toThrow(/transition/);
    expect(() => certifyState(state)).toThrow(/evidence/);
  });

  test("candidate edits invalidate geometry-dependent review evidence", () => {
    let state = createTaskState({ taskId: "x", profile: "generic", style: "low-poly-faithful" });
    state = bindOracle(state, "oracle-a");
    state = bindCandidate(state, "candidate-a");
    state = recordEvidence(state, { id: "review", kind: "visual-review", phase: "visual-review", artifact: "review.json", passed: true, oracleHash: "oracle-a", candidateHash: "candidate-a" });
    state = bindCandidate(state, "candidate-b");
    expect(state.evidence.review?.valid).toBe(false);
  });

  test("oracle edits invalidate all comparison evidence", () => {
    let state = createTaskState({ taskId: "x", profile: "tank", style: "low-poly-faithful" });
    state = bindOracle(state, "oracle-a");
    state = bindCandidate(state, "candidate-a");
    state = recordEvidence(state, { id: "gate", kind: "deterministic-gate", phase: "hull", artifact: "gate.json", passed: true, oracleHash: "oracle-a", candidateHash: "candidate-a" });
    state = bindOracle(state, "oracle-b");
    expect(state.evidence.gate?.valid).toBe(false);
  });

  test("repeated no-progress forces diagnosis without a fixed retry stop", () => {
    let state = createTaskState({ taskId: "x", profile: "generic", style: "low-poly-faithful" });
    for (let index = 0; index < 20; index += 1) {
      state = recordAttempt(state, { action: "repair-primary", evidenceHash: "same", score: 0.4 });
    }
    expect(state.route).toBe("diagnose");
    expect(state.status).toBe("active");
    expect(state.attempts).toHaveLength(20);
  });

  test("persists atomically and resumes all separated state categories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-state-"));
    const path = join(directory, "state.json");
    const state = createTaskState({ taskId: "resume", profile: "generic", style: "low-poly-faithful" });
    state.observedFacts.push({ id: "width", value: 4, source: "oracle", confidence: 1, status: "supports" });
    await saveTaskState(path, state);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
    expect((await loadTaskState(path)).observedFacts[0]?.value).toBe(4);
  });

  test("migrates legacy state conservatively and invalidates unverifiable evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-state-legacy-"));
    const path = join(directory, "state.json");
    const legacy = createTaskState({ taskId: "legacy", profile: "generic", style: "low-poly-faithful" }) as unknown as Record<string, unknown>;
    for (const key of ["profileContractHash", "activePhase", "locks", "reopens", "visualReviewStatus", "evidenceConfigHashes", "phaseGeometryHashes"]) delete legacy[key];
    await writeFile(path, `${JSON.stringify(legacy)}\n`);
    const migrated = await loadTaskState(path);
    expect(migrated.activePhase).toBe("oracle-registration");
    expect(migrated.systemDecisions.at(-1)?.id).toBe("state-contract-migration");
  });

  test("fails closed on contradictory persisted evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-state-corrupt-"));
    const path = join(directory, "state.json");
    let state = bindCandidate(bindOracle(createTaskState({ taskId: "corrupt", profile: "generic", style: "low-poly-faithful" }), "oracle-a"), "candidate-a");
    state = recordEvidence(state, { id: "gate", kind: "deterministic-gate", phase: "geometry", artifact: "gate.json", passed: true, oracleHash: "oracle-a", candidateHash: "candidate-a" });
    state.evidence.gate!.candidateHash = "candidate-other";
    await saveTaskState(path, state);
    await expect(loadTaskState(path)).rejects.toThrow(/contradictory/);
  });

  test("selects evidence-driven next actions without an attempt ceiling", () => {
    let state = createTaskState({ taskId: "next", profile: "generic", style: "low-poly-faithful" });
    expect(determineNextAction(state).route).toBe("onboard-oracle");
    state = bindOracle(state, "oracle-a");
    state = bindCandidate(state, "candidate-a");
    expect(determineNextAction(state).route).toBe("onboard-oracle");
    state.route = "diagnose";
    expect(determineNextAction(state).reason).toMatch(/diagnos/);
  });

  test("requires a reason for skipped phases and admitted dimensions for exact-real certification", () => {
    let state = createTaskState({ taskId: "exact", profile: "tank", style: "low-poly-faithful", certification: "exact-real" });
    expect(() => skipPhase(state, "style-fabrication", "")).toThrow(/reason/);
    expect(() => skipPhase(state, "style-fabrication", "equivalent artifact")).toThrow(/required/);
    expect(() => setAuthoritativeDimensionStatus(state, "admitted", [])).toThrow(/source/);
    state = setAuthoritativeDimensionStatus(state, "admitted", ["manufacturer manual p. 12"]);
    expect(state.authoritativeDimensions.status).toBe("admitted");
  });

  test("certifies only a complete set bound to the final hashes", async () => {
    let state = bindCandidatePhases(bindOracle(createTaskState({ taskId: "complete", profile: "generic", style: "low-poly-faithful" }), "oracle-final"), "candidate-final", { "primary-mass": "primary-mass", attachments: "attachments", "identity-features": "identity-features", "style-complexity": "style-complexity", "visual-review": "visual-review" });
    state.profileContractHash = profileContractHash(await loadProfileContract("generic"));
    const phaseEvidence = [
      ["oracle-registration", "registration"], ["primary-mass", "deterministic-gate"], ["attachments", "articulation"],
      ["identity-features", "complexity"], ["style-complexity", "style"], ["visual-review", "visual-review"],
    ] as const;
    for (const [phase, kind] of phaseEvidence) {
      const artifact = createEvidenceArtifact({ id: kind, kind, phase, oracleHash: "oracle-final", candidateHash: "candidate-final", profileContractHash: state.profileContractHash, configHash: "fixture", result: { passed: true, summary: "fixture" } });
      state = recordEvidenceArtifact(state, `${kind}.json`, artifact);
      state = acceptPhase(state, phase, { geometryHash: phase, evidenceIds: [kind], contractHash: state.profileContractHash });
    }
    const turntable = createEvidenceArtifact({ id: "turntable", kind: "turntable", phase: "visual-review", oracleHash: "oracle-final", candidateHash: "candidate-final", profileContractHash: state.profileContractHash, configHash: "fixture", result: { passed: true, summary: "fixture" } });
    state = recordEvidenceArtifact(state, "turntable.json", turntable);
    expect(certifyState(state).status).toBe("certified");
  });
});

describe("routing and permissions", () => {
  test.each([
    ["Reconstruct this T-34 tank", "tank"],
    ["A tracked armored vehicle with turret and gun", "tank"],
    ["Reconstruct this house", "generic"],
    ["Industrial pressure machine with cylindrical barrel", "generic"],
    ["Ambiguous rigid prop", "generic"],
  ] as const)("routes %s to %s", (prompt, expected) => {
    expect(routeSubject(prompt)).toBe(expected);
  });

  test("enforces role mutation boundaries", () => {
    expect(() => assertRoutePermission("visual-review", "edit-candidate")).toThrow(/not permitted/);
    expect(() => assertRoutePermission("build", "edit-oracle")).toThrow(/not permitted/);
    expect(() => assertRoutePermission("repair-oracle", "edit-prepared-oracle")).not.toThrow();
  });
});

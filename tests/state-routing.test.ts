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
  createEvaluationIdentity,
  createRenderEvidenceArtifact,
  createRuntimeEvaluationEvidenceArtifact,
  createRuntimeGateEvidenceArtifact,
  createWorkflowGateEvidenceArtifact,
  createTaskState,
  loadTaskState,
  loadProfileContract,
  profileContractHash,
  determineNextAction,
  evaluationIdentityHash,
  recordAttempt,
  recordEvidence,
  recordEvidenceArtifact,
  routeSubject,
  saveTaskState,
  setAuthoritativeDimensionStatus,
  skipPhase,
  transitionRoute,
  verifyEvidenceArtifact,
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

  test("rejects passing evidence from a different style contract", () => {
    const state = bindCandidate(bindOracle(createTaskState({ taskId: "style-drift", profile: "generic", style: "low-poly-faithful" }), "oracle"), "candidate");
    const artifact = createRuntimeEvaluationEvidenceArtifact({ id: "wrong-style", kind: "style", phase: "style-complexity", oracleHash: "oracle", candidateHash: "candidate", profileContractHash: state.profileContractHash, styleContractHash: "different-style-contract", evaluationIdentityHash: "evaluation", configHash: "evaluation", report: { profile: "generic", passed: true, score: 100, rows: [{ code: "style.fixture", phase: "style-complexity", component: "fixture", passed: true, score: 100, severity: "major", message: "fixture" }], workorders: [] } });
    expect(() => recordEvidenceArtifact(state, "wrong-style.json", artifact)).toThrow(/style contract is stale/);
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
    for (let index = 0; index < 20; index += 1) state = recordAttempt(state, { action: "repair-primary", evidenceHash: "same", score: 0.4 });
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

  test("invalidates legacy verified evidence that lacks explicit authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-state-authority-legacy-"));
    const path = join(directory, "state.json");
    let state = bindCandidate(bindOracle(createTaskState({ taskId: "legacy-authority", profile: "generic", style: "low-poly-faithful" }), "oracle-a"), "candidate-a");
    state.evidenceConfigHashes["deterministic-gate"] = "config";
    state.evidence.gate = { id: "gate", kind: "deterministic-gate", phase: "primary-mass", artifact: "gate.json", passed: true, oracleHash: "oracle-a", candidateHash: "candidate-a", valid: true, verified: true, createdAt: new Date().toISOString(), configHash: "config" };
    state.locks["primary-mass"] = { phase: "primary-mass", geometryHash: "geometry", evidence: [], oracleHash: "oracle-a", candidateHash: "candidate-a", contractHash: state.profileContractHash, acceptedAt: new Date().toISOString() };
    await saveTaskState(path, state);
    const migrated = await loadTaskState(path);
    expect(migrated.evidence.gate).toMatchObject({ valid: false, verified: false });
    expect(migrated.locks).toEqual({});
    expect(migrated.systemDecisions.at(-1)?.id).toBe("state-evidence-authority-migration");
  });

  test("rejects evidence artifacts labeled with the previous schema", () => {
    const artifact = createEvidenceArtifact({ id: "schema", kind: "style", phase: "style-complexity", oracleHash: "oracle", candidateHash: "candidate", profileContractHash: "contract", configHash: "config", result: { passed: true, summary: "fixture" } });
    expect(() => verifyEvidenceArtifact({ ...artifact, schemaVersion: 2 } as unknown as typeof artifact)).toThrow(/schema/);
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

  test("does not route past build on declared machine-evidence summaries", () => {
    let state = bindCandidate(bindOracle(createTaskState({ taskId: "declared-summaries", profile: "generic", style: "low-poly-faithful" }), "oracle"), "candidate");
    state = recordEvidenceArtifact(state, "registration.json", createWorkflowGateEvidenceArtifact({ id: "registration", kind: "registration", phase: "oracle-registration", oracleHash: "oracle", candidateHash: null, profileContractHash: state.profileContractHash, configHash: "fixture", gateCode: "registration.complete", passed: true, summary: "fixture" }));
    state = acceptPhase(state, "oracle-registration", { geometryHash: "oracle", evidenceIds: ["registration"], contractHash: state.profileContractHash });
    for (const kind of ["deterministic-gate", "style", "complexity", "turntable"] as const) {
      state = recordEvidenceArtifact(state, `${kind}.json`, createEvidenceArtifact({ id: kind, kind, phase: "final", oracleHash: "oracle", candidateHash: "candidate", profileContractHash: state.profileContractHash, configHash: "fixture", result: { passed: true, summary: "declared" } }));
    }
    expect(determineNextAction(state)).toMatchObject({ route: "build" });
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
    const identity = createEvaluationIdentity({ evaluatorVersion: "fixture", measurementVersion: "fixture", profile: "generic", profileContractHash: state.profileContractHash, styleContractHash: state.styleContractHash, subjectContractHash: null, certification: "oracle-relative", oraclePreparationHash: "preparation-final", preparedOracleHash: "oracle-final", authoritativeDimensionsHash: null, candidateSourceHash: "source", candidateNeutralHash: "neutral" });
    const identityHash = evaluationIdentityHash(identity);
    state.evaluationIdentity = identity;
    state.evaluationIdentityHash = identityHash;
    const phaseEvidence = [["oracle-registration", "registration"], ["primary-mass", "deterministic-gate"], ["attachments", "articulation"], ["identity-features", "complexity"], ["style-complexity", "style"], ["visual-review", "visual-review"]] as const;
    const gatesByPhase: Record<string, string[]> = {
      "oracle-registration": ["registration.complete"], "primary-mass": ["dimensions.robust", "orientation.physical", "silhouette.views"], attachments: ["attachments.contract"], "identity-features": ["semantics.critical"], "style-complexity": ["connectivity.contract", "style.contract", "style.complexity"], "visual-review": ["visual.review"],
    };
    for (const [phase, kind] of phaseEvidence) {
      const gateResults = gatesByPhase[phase]!.map((code) => ({ code, passed: true, score: 100 }));
      const artifact = phase === "oracle-registration" || phase === "visual-review"
        ? createWorkflowGateEvidenceArtifact({ id: kind, kind: kind as "registration" | "visual-review", phase, oracleHash: "oracle-final", candidateHash: "candidate-final", profileContractHash: state.profileContractHash, styleContractHash: state.styleContractHash, evaluationIdentityHash: phase === "oracle-registration" ? null : identityHash, configHash: "fixture", gateCode: phase === "oracle-registration" ? "registration.complete" : "visual.review", passed: true, summary: "fixture" })
        : createRuntimeGateEvidenceArtifact({ id: kind, phase, oracleHash: "oracle-final", candidateHash: "candidate-final", profileContractHash: state.profileContractHash, styleContractHash: state.styleContractHash, evaluationIdentityHash: identityHash, configHash: identityHash, report: { profile: "generic", passed: true, score: 100, rows: gateResults.map((gate) => ({ ...gate, phase, component: "fixture", severity: "critical", message: "fixture" })), workorders: [] } });
      state = recordEvidenceArtifact(state, `${kind}.json`, artifact);
      state = acceptPhase(state, phase, { geometryHash: phase, evidenceIds: [kind], contractHash: state.profileContractHash });
    }
    for (const kind of ["style", "complexity"] as const) {
      state = recordEvidenceArtifact(state, `${kind}-summary.json`, createRuntimeEvaluationEvidenceArtifact({ id: `${kind}-summary`, kind, phase: "style-complexity", oracleHash: "oracle-final", candidateHash: "candidate-final", profileContractHash: state.profileContractHash, styleContractHash: state.styleContractHash, evaluationIdentityHash: identityHash, configHash: identityHash, report: { profile: "generic", passed: true, score: 100, rows: [{ code: `${kind}.fixture`, phase: "style-complexity", component: "fixture", passed: true, score: 100, severity: "major", message: "fixture" }], workorders: [] } }));
    }
    state = recordEvidenceArtifact(state, "turntable.json", createRenderEvidenceArtifact({ id: "turntable", phase: "visual-review", oracleHash: "oracle-final", candidateHash: "candidate-final", profileContractHash: state.profileContractHash, styleContractHash: state.styleContractHash, evaluationIdentityHash: identityHash, configHash: identityHash, manifest: { turntable: [{ path: "turntable.png", sha256: "a".repeat(64) }] } }));
    expect(certifyState(state).status).toBe("certified");
  });

  test("requires runtime authority for a finalizer-owned deterministic gate", async () => {
    const contract = await loadProfileContract("tank");
    const phaseHashes = Object.fromEntries(contract.phases.filter((phase) => phase.id !== "final").map((phase) => [phase.id, phase.id]));
    let state = bindCandidatePhases(bindOracle(createTaskState({ taskId: "final-authority", profile: "tank", style: "low-poly-faithful" }), "oracle"), "candidate", phaseHashes);
    for (const phase of contract.phases.filter((item) => item.id !== "final")) {
      const id = `phase-${phase.id}`;
      const artifact = phase.owner === "oracle" || phase.owner === "reviewer"
        ? createWorkflowGateEvidenceArtifact({ id, kind: phase.owner === "oracle" ? "registration" : "visual-review", phase: phase.id, oracleHash: "oracle", candidateHash: "candidate", profileContractHash: state.profileContractHash, configHash: "fixture", gateCode: phase.owner === "oracle" ? "registration.complete" : "visual.review", passed: true, summary: "fixture" })
        : createRuntimeGateEvidenceArtifact({ id, phase: phase.id, oracleHash: "oracle", candidateHash: "candidate", profileContractHash: state.profileContractHash, configHash: "fixture", report: { profile: "tank", passed: true, score: 100, rows: phase.requiredGates.map((code) => ({ code, phase: phase.id, component: "fixture", passed: true, score: 100, severity: "critical", message: "fixture" })), workorders: [] } });
      state = recordEvidenceArtifact(state, `${id}.json`, artifact);
      state = acceptPhase(state, phase.id, { geometryHash: phase.id, evidenceIds: [id], contractHash: state.profileContractHash });
    }
    for (const kind of ["style", "complexity", "articulation", "turntable"] as const) {
      state = recordEvidenceArtifact(state, `${kind}.json`, createEvidenceArtifact({ id: kind, kind, phase: "style-fabrication", oracleHash: "oracle", candidateHash: "candidate", profileContractHash: state.profileContractHash, configHash: "fixture", result: { passed: true, summary: "fixture" } }));
    }
    const identity = createEvaluationIdentity({ evaluatorVersion: "fixture", measurementVersion: "fixture", profile: "tank", profileContractHash: state.profileContractHash, styleContractHash: state.styleContractHash, subjectContractHash: null, certification: "oracle-relative", oraclePreparationHash: "preparation", preparedOracleHash: "oracle", authoritativeDimensionsHash: null, candidateSourceHash: "source", candidateNeutralHash: "neutral" });
    state.evaluationIdentity = identity;
    state.evaluationIdentityHash = evaluationIdentityHash(identity);
    state = recordEvidenceArtifact(state, "claimed-final.json", createEvidenceArtifact({ id: "claimed-final", kind: "deterministic-gate", phase: "final", oracleHash: "oracle", candidateHash: "candidate", profileContractHash: state.profileContractHash, styleContractHash: state.styleContractHash, evaluationIdentityHash: state.evaluationIdentityHash, configHash: "fixture", gateResults: [{ code: "curves.whole", passed: true, score: 100 }], result: { passed: true, summary: "claimed final pass" } }));
    expect(() => certifyState(state)).toThrow(/final gates/);
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

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertRoutePermission,
  bindCandidate,
  bindOracle,
  certifyState,
  createTaskState,
  loadTaskState,
  determineNextAction,
  recordAttempt,
  recordEvidence,
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

  test("candidate edits invalidate geometry-dependent critic evidence", () => {
    let state = createTaskState({ taskId: "x", profile: "generic", style: "low-poly-faithful" });
    state = bindOracle(state, "oracle-a");
    state = bindCandidate(state, "candidate-a");
    state = recordEvidence(state, { id: "critic", kind: "critic", phase: "final", artifact: "critic.json", passed: true, oracleHash: "oracle-a", candidateHash: "candidate-a" });
    state = bindCandidate(state, "candidate-b");
    expect(state.evidence.critic?.valid).toBe(false);
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
    expect(determineNextAction(state).route).toBe("build");
    state.route = "diagnose";
    expect(determineNextAction(state).reason).toMatch(/diagnos/);
  });

  test("requires a reason for skipped phases and admitted dimensions for exact-real certification", () => {
    let state = createTaskState({ taskId: "exact", profile: "tank", style: "low-poly-faithful", certification: "exact-real" });
    expect(() => skipPhase(state, "style", "")).toThrow(/reason/);
    state = skipPhase(state, "style", "style is covered by an equivalent signed artifact");
    expect(state.phaseStatus.style).toBe("skipped");
    expect(() => setAuthoritativeDimensionStatus(state, "admitted", [])).toThrow(/source/);
    state = setAuthoritativeDimensionStatus(state, "admitted", ["manufacturer manual p. 12"]);
    expect(state.authoritativeDimensions.status).toBe("admitted");
  });

  test("certifies only a complete set bound to the final hashes", () => {
    let state = bindCandidate(bindOracle(createTaskState({ taskId: "complete", profile: "generic", style: "low-poly-faithful" }), "oracle-final"), "candidate-final");
    for (const kind of ["registration", "deterministic-gate", "style", "complexity", "articulation", "critic", "turntable"] as const) {
      state = recordEvidence(state, { id: kind, kind, phase: "final", artifact: `${kind}.json`, passed: true, oracleHash: "oracle-final", candidateHash: "candidate-final" });
    }
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
    expect(() => assertRoutePermission("critic", "edit-candidate")).toThrow(/not permitted/);
    expect(() => assertRoutePermission("build", "edit-oracle")).toThrow(/not permitted/);
    expect(() => assertRoutePermission("repair-oracle", "edit-prepared-oracle")).not.toThrow();
  });
});

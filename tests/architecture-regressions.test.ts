import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  acceptPhase,
  bindCandidate,
  bindCandidatePhases,
  bindEvidenceConfig,
  bindOracle,
  auditCandidateModule,
  certifyStateFromArtifacts,
  createEvidenceArtifact,
  createRuntimeGateEvidenceArtifact,
  createWorkflowGateEvidenceArtifact,
  createTaskState,
  deriveCanonicalFrame,
  createDerivativeCacheEntry,
  evaluateCandidate,
  evaluateProfileContractGates,
  loadTaskState,
  loadProfileContract,
  profileContractHash,
  recordEvidenceArtifact,
  readDerivativeCache,
  reopenPhase,
  saveTaskState,
  validateProfileContract,
} from "../src/index.js";
import { createTankFixture } from "./helpers/scenes.js";

describe("executable profile contracts", () => {
  test("loads one contract per profile and rejects declarations the runtime cannot execute", async () => {
    const contract = await loadProfileContract("tank");
    expect(contract.phases.map((phase) => phase.id)).toEqual([
      "oracle-registration", "hull", "turret", "gun", "running-gear", "tracks",
      "fittings-articulation", "style-fabrication", "visual-review", "final",
    ]);
    expect(validateProfileContract({ ...contract, operators: [...contract.operators, "imaginary-operator"] }).valid).toBe(false);
    expect(validateProfileContract({ ...contract, operators: [...contract.operators, "attachments"] }).errors).toContain("operator attachments is enabled but unused by every gate");
    expect(validateProfileContract({ ...contract, gates: contract.gates.filter((gate) => gate.code !== "gun.pose") }).valid).toBe(false);
  });

  test("derives new task lifecycle authority directly from the bundled profile contract", async () => {
    const contract = await loadProfileContract("generic");
    const state = createTaskState({ taskId: "contract-state", profile: "generic", style: "low-poly-faithful" });
    expect(Object.keys(state.phaseStatus)).toEqual(contract.phases.map((phase) => phase.id));
    expect(state.profileContractHash).toBe(profileContractHash(contract));
  });

  test("fails contract execution when a declared required view was not evaluated", async () => {
    const contract = await loadProfileContract("tank");
    const changed = structuredClone(contract);
    changed.gates.find((gate) => gate.code === "curves.hull")!.views!.push("rear");
    const evaluation = evaluateCandidate({ oracle: createTankFixture(), candidate: createTankFixture(), profile: "tank" });
    const report = evaluateProfileContractGates(changed, { deterministic: evaluation.deterministic.rows });
    expect(report.rows.find((row) => row.code === "curves.hull")).toMatchObject({ passed: false });
    expect(report.rows.find((row) => row.code === "curves.hull")?.message).toMatch(/rear/);
  });

  test("reports contract gates independently for every phase", () => {
    const oracle = createTankFixture();
    const candidate = createTankFixture({ turretShift: 0.5 });
    const evaluation = evaluateCandidate({ oracle, candidate, profile: "tank" });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.phaseGates.hull).toMatchObject({ passed: true });
    expect(evaluation.phaseGates.turret).toMatchObject({ passed: false });
    expect(evaluation.phaseGates.hull?.rows.map((row) => row.phase)).toEqual(["hull", "hull", "hull", "hull"]);
  });
});

describe("phase locks and artifact authority", () => {
  test("rejects passing labels that do not prove every gate required by the phase", () => {
    let state = bindCandidatePhases(bindOracle(createTaskState({ taskId: "gate-proof", profile: "tank", style: "low-poly-faithful" }), "oracle"), "candidate", { hull: "hull" });
    const artifact = createEvidenceArtifact({
      id: "claimed-hull",
      kind: "deterministic-gate",
      phase: "hull",
      oracleHash: "oracle",
      candidateHash: "candidate",
      profileContractHash: state.profileContractHash,
      configHash: "fixture",
      gateResults: ["curves.hull", "hull.stations", "dimensions.hull-length", "orientation.physical"].map((code) => ({ code, passed: true, score: 100 })),
      result: { passed: true, summary: "claimed pass" },
    });
    state = recordEvidenceArtifact(state, "claimed-hull.json", artifact);
    expect(() => acceptPhase(state, "hull", { geometryHash: "hull", evidenceIds: [artifact.id], contractHash: state.profileContractHash })).toThrow(/required gates/i);
  });

  test("prevents silent changes to accepted geometry and invalidates dependants on explicit reopen", async () => {
    let state = bindCandidate(bindOracle(createTaskState({ taskId: "lock", profile: "tank", style: "low-poly-faithful" }), "oracle"), "candidate-a");
    for (const [id, kind, phase] of [["registration", "registration", "oracle-registration"], ["hull-gate", "deterministic-gate", "hull"]] as const) {
      const gateResults = phase === "oracle-registration"
        ? [{ code: "registration.complete", passed: true, score: 100 }]
        : ["curves.hull", "hull.stations", "dimensions.hull-length", "orientation.physical"].map((code) => ({ code, passed: true, score: 100 }));
      const artifact = phase === "oracle-registration"
        ? createWorkflowGateEvidenceArtifact({ id, kind, phase, oracleHash: "oracle", candidateHash: "candidate-a", profileContractHash: state.profileContractHash, configHash: "fixture", gateCode: "registration.complete", passed: true, summary: "fixture" })
        : createRuntimeGateEvidenceArtifact({ id, phase, oracleHash: "oracle", candidateHash: "candidate-a", profileContractHash: state.profileContractHash, configHash: "fixture", report: { profile: "tank", passed: true, score: 100, rows: gateResults.map((gate) => ({ ...gate, phase, component: "fixture", severity: "critical", message: "fixture" })), workorders: [] } });
      state = recordEvidenceArtifact(state, `${id}.json`, artifact);
    }
    state = acceptPhase(state, "oracle-registration", { geometryHash: "oracle", evidenceIds: ["registration"], contractHash: state.profileContractHash });
    state.phaseGeometryHashes.hull = "hull-a";
    state = acceptPhase(state, "hull", { geometryHash: "hull-a", evidenceIds: ["hull-gate"], contractHash: state.profileContractHash });
    const advanced = bindCandidatePhases(state, "candidate-with-turret", { hull: "hull-a", turret: "turret-a" });
    expect(advanced.evidence["hull-gate"]).toMatchObject({ valid: true, verified: true });
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-advanced-lock-"));
    const statePath = join(directory, "state.json");
    await saveTaskState(statePath, advanced);
    await expect(loadTaskState(statePath)).resolves.toMatchObject({ candidateHash: "candidate-with-turret" });
    expect(() => bindCandidate(state, "candidate-b")).toThrow(/locked phase/i);
    state = reopenPhase(state, "hull", "correct a measured station regression");
    state = bindCandidate(state, "candidate-b");
    expect(state.phaseStatus.hull).toBe("invalidated");
    expect(state.phaseStatus.turret).toBe("invalidated");
    expect(state.reopens).toHaveLength(1);
  });

  test("derives certification from hash-bound artifact files and rejects a passed boolean forgery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-artifacts-"));
    let state = bindCandidate(bindOracle(createTaskState({ taskId: "proof", profile: "generic", style: "low-poly-faithful" }), "oracle"), "candidate");
    const kinds = ["registration", "deterministic-gate", "style", "complexity", "articulation", "visual-review", "turntable"] as const;
    for (const kind of kinds) {
      const artifact = createEvidenceArtifact({ id: kind, kind, phase: "final", oracleHash: "oracle", candidateHash: "candidate", profileContractHash: state.profileContractHash, configHash: "config", result: { passed: true, summary: "fixture" } });
      const path = join(directory, `${kind}.json`);
      await writeFile(path, `${JSON.stringify(artifact)}\n`);
      state = recordEvidenceArtifact(state, path, artifact);
    }
    const forgedPath = join(directory, "style.json");
    const forged = JSON.parse(await readFile(forgedPath, "utf8"));
    forged.result.summary = "tampered";
    await writeFile(forgedPath, `${JSON.stringify(forged)}\n`);
    await expect(certifyStateFromArtifacts(state)).rejects.toThrow(/hash/i);
  });

  test("requires an explicit reason before changing evidence configuration", () => {
    let state = bindCandidate(bindOracle(createTaskState({ taskId: "config", profile: "generic", style: "low-poly-faithful" }), "oracle"), "candidate");
    const artifact = createEvidenceArtifact({ id: "gate", kind: "deterministic-gate", phase: "primary-mass", oracleHash: "oracle", candidateHash: "candidate", profileContractHash: state.profileContractHash, configHash: "config-a", result: { passed: true, summary: "fixture" } });
    state = recordEvidenceArtifact(state, "gate.json", artifact);
    expect(() => bindEvidenceConfig(state, "deterministic-gate", "config-b", "")).toThrow(/reason/);
    state = bindEvidenceConfig(state, "deterministic-gate", "config-b", "camera precision changed");
    expect(state.evidence.gate?.valid).toBe(false);
  });
});

describe("scale-independent physical evaluation", () => {
  test("freezes matched cameras and increases resolution when physical precision requires it", () => {
    const coarse = deriveCanonicalFrame({ min: [-5, 0, -10], max: [5, 4, 10], size: [10, 4, 20], center: [0, 2, 0] }, 0.2);
    const fine = deriveCanonicalFrame({ min: [-5, 0, -10], max: [5, 4, 10], size: [10, 4, 20], center: [0, 2, 0] }, 0.02);
    expect(fine.width).toBeGreaterThan(coarse.width);
    expect(fine.frameHash).not.toBe(coarse.frameHash);
    expect(fine.cameras.side.target).toEqual([0, 2, 0]);
  });

  test("rejects metadata-only physical reversal", () => {
    const candidate = createTankFixture();
    candidate.userData.forwardAxis = "+z";
    candidate.scale.z = -1;
    const report = evaluateCandidate({ oracle: createTankFixture(), candidate, profile: "tank" }).deterministic;
    expect(report.rows.find((row) => row.code === "orientation.physical")?.passed).toBe(false);
  });

  test("rejects opposite wheel scale errors", () => {
    const candidate = createTankFixture();
    (candidate.getObjectByName("road-wheel--1-0") as THREE.Mesh).scale.setScalar(0.8);
    (candidate.getObjectByName("road-wheel-1-0") as THREE.Mesh).scale.setScalar(1.2);
    const report = evaluateCandidate({ oracle: createTankFixture(), candidate, profile: "tank" }).deterministic;
    expect(report.rows.some((row) => row.code.startsWith("running-gear.instance") && !row.passed)).toBe(true);
  });

  test.each([
    ["displaced", (candidate: THREE.Object3D) => { (candidate.getObjectByName("track-1") as THREE.Mesh).position.y += 1; }],
    ["box-shaped", (candidate: THREE.Object3D) => {
      for (const side of [-1, 1]) (candidate.getObjectByName(`track-${side}`) as THREE.Mesh).geometry = new THREE.BoxGeometry(0.25, 1.25, 5.5);
    }],
    ["chamfer-spoofed", (candidate: THREE.Object3D) => {
      for (const side of [-1, 1]) {
        const shape = new THREE.Shape();
        const points: Array<[number, number]> = [[-2.4, -0.625], [2.4, -0.625], [2.75, -0.275], [2.75, 0.275], [2.4, 0.625], [-2.4, 0.625], [-2.75, 0.275], [-2.75, -0.275]];
        shape.moveTo(...points[0]!); for (const point of points.slice(1)) shape.lineTo(...point); shape.closePath();
        const hole = new THREE.Path();
        const inner: Array<[number, number]> = [[-2.19, -0.415], [2.19, -0.415], [2.54, -0.065], [2.54, 0.065], [2.19, 0.415], [-2.19, 0.415], [-2.54, 0.065], [-2.54, -0.065]];
        hole.moveTo(...inner[0]!); for (const point of inner.slice(1)) hole.lineTo(...point); hole.closePath(); shape.holes.push(hole);
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: false, curveSegments: 1, steps: 1 });
        geometry.translate(0, 0, -0.125); geometry.rotateY(Math.PI / 2);
        (candidate.getObjectByName(`track-${side}`) as THREE.Mesh).geometry = geometry;
      }
    }],
    ["missing-upper-run", (candidate: THREE.Object3D) => {
      for (const side of [-1, 1]) {
        const position = (candidate.getObjectByName(`track-${side}`) as THREE.Mesh).geometry.getAttribute("position");
        for (let index = 0; index < position.count; index += 1) if (position.getY(index) > 0) position.setY(index, 0);
        position.needsUpdate = true;
      }
    }],
  ] as const)("rejects %s fake track courses", (_label, mutate) => {
    const candidate = createTankFixture();
    mutate(candidate);
    const report = evaluateCandidate({ oracle: createTankFixture(), candidate, profile: "tank" }).deterministic;
    expect(report.rows.find((row) => row.code === "track.course")?.passed).toBe(false);
  });

  test("rejects track penetration into the 3D hull envelope", () => {
    const candidate = createTankFixture();
    (candidate.getObjectByName("track-1") as THREE.Mesh).position.x = 1;
    const row = evaluateCandidate({ oracle: createTankFixture(), candidate, profile: "tank" }).deterministic.rows.find((item) => item.code === "track.course");
    expect(row?.passed).toBe(false);
    expect(row?.message).toMatch(/AABB hull-envelope penetration/);
  });
});

describe("integrity boundaries", () => {
  test("invalidates derivative caches when camera, profile, or material input changes", () => {
    const identity = { sourceHash: "source", preparedHash: "prepared", candidateHash: "candidate", profileContractHash: "profile", measurementVersion: "2", cameraFrameHash: "camera", renderConfigHash: "render", materialHash: "material-a" };
    const entry = createDerivativeCacheEntry(identity, { score: 100 });
    expect(readDerivativeCache(entry, identity)).toEqual({ score: 100 });
    expect(readDerivativeCache(entry, { ...identity, materialHash: "material-b" })).toBeUndefined();
  });

  test("audits local transitive candidate dependencies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-transitive-"));
    await writeFile(join(directory, "helper.mjs"), "new GLTFLoader().load('reference.glb'); export const x = 1;\n");
    await writeFile(join(directory, "candidate.mjs"), "import { x } from './helper.mjs'; export function createCandidate(){ return x; }\n");
    const audit = await auditCandidateModule(join(directory, "candidate.mjs"));
    expect(audit.passed).toBe(false);
    expect(audit.files).toHaveLength(2);
    expect(audit.findings.some((finding) => finding.code === "oracle-runtime-load")).toBe(true);
  });
});

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createDeterministicReplayPacket,
  createEvidenceArtifact,
  createFitting,
  createFrustum,
  createLoftGeometry,
  createPlate,
  createPrism,
  createRadialLoftGeometry,
  createTrackCourseGeometry,
  createTube,
  createVisualReviewPacket,
  createVisualReviewVerdict,
  createWheel,
  createDerivativeCacheEntry,
  derivativeCacheKey,
  deriveCanonicalFrame,
  evaluateCandidateWithPoses,
  evaluateGenericProfile,
  inspectAllUpstreamDrift,
  loadTaskState,
  materialDiagnosticKey,
  validateProfileContract,
  verifyVisualReviewVerdict,
  repeatParts,
  runCli,
  snapshotScene,
} from "../src/index.js";
import { createGenericFixture, createTankFixture } from "./helpers/scenes.js";

const io = () => {
  const output: string[] = [];
  return { output, sink: { stdout: (value: string) => output.push(value), stderr: (value: string) => output.push(value) } };
};

describe("extended durable CLI", () => {
  test("binds, records, locks, reopens, tracks attempts, groups workorders, and replays rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh2threejs-lifecycle-"));
    const statePath = join(root, ".mesh2threejs", "state.json");
    const init = io();
    expect(await runCli(["init", "--workspace", root, "--id", "life", "--goal", "fixture", "--profile", "generic"], init.sink)).toBe(0);
    expect(await runCli(["bind-oracle", root, "--hash", "oracle"], io().sink)).toBe(0);
    expect(await runCli(["bind-candidate", root, "--hash", "candidate"], io().sink)).toBe(0);
    let state = await loadTaskState(statePath);
    const registration = createEvidenceArtifact({ id: "registration", kind: "registration", phase: "oracle-registration", oracleHash: "oracle", candidateHash: null, profileContractHash: state.profileContractHash, configHash: "config", result: { passed: true, summary: "registered" } });
    const artifactPath = join(root, ".mesh2threejs", "evidence", "registration.json");
    await mkdir(join(root, ".mesh2threejs", "evidence"), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(registration)}\n`);
    expect(await runCli(["record-evidence", root, "--artifact", ".mesh2threejs/evidence/registration.json"], io().sink)).toBe(0);
    expect(await runCli(["lock", root, "--phase", "oracle-registration", "--geometry-hash", "oracle", "--evidence", "registration"], io().sink)).toBe(0);
    expect(await runCli(["reopen", root, "--phase", "oracle-registration", "--reason", "fixture correction"], io().sink)).toBe(0);
    expect(await runCli(["attempt", root, "--action", "repair", "--evidence-hash", "same", "--score", "42"], io().sink)).toBe(0);
    expect(await runCli(["bind-config", statePath, "--kind", "registration", "--hash", "config-b", "--reason", "registration tolerance changed"], io().sink)).toBe(0);
    expect(await runCli(["bind-config", statePath, "--kind", "unknown", "--hash", "x", "--reason", "fixture"], io().sink)).toBe(2);

    const reportPath = join(root, "report.json");
    await writeFile(reportPath, JSON.stringify({ workorders: [{ phase: "primary-mass", component: "primary", errorKind: "dimensions", priority: "critical", correction: "resize", repairGroup: "primary-mass:primary" }] }));
    const work = io();
    expect(await runCli(["workorders", reportPath, "--phase", "primary-mass"], work.sink)).toBe(0);
    expect(JSON.parse(work.output[0]!).workorders).toHaveLength(1);

    const replayPath = join(root, "replay.json");
    await writeFile(replayPath, JSON.stringify(createDeterministicReplayPacket({ oracleHash: "oracle", candidateHash: "candidate", rows: [] })));
    expect(await runCli(["replay-gates", replayPath], io().sink)).toBe(0);
  });

  test("prepares and records a genuine external visual verdict", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh2threejs-review-"));
    const statePath = join(root, ".mesh2threejs", "state.json");
    await runCli(["init", "--workspace", root, "--id", "review", "--goal", "fixture", "--profile", "generic"], io().sink);
    await runCli(["bind-oracle", root, "--hash", "oracle"], io().sink);
    await runCli(["bind-candidate", root, "--hash", "candidate"], io().sink);
    const state = await loadTaskState(statePath);
    const hash = "a".repeat(64);
    const config = { oracleHash: "oracle", candidateHash: "candidate", profile: "generic" as const, profileContractHash: state.profileContractHash, styleHash: hash, deterministicArtifactHash: hash, captures: [{ path: "beauty.png", sha256: hash, pass: "beauty", cameraId: "hero" }], comparisonBoardHashes: [hash], turntableHashes: [hash], articulationArtifactHash: hash, regionEvidence: { status: "available" as const, semanticArtifactHash: hash } };
    const configPath = join(root, "review-config.json"); const packetPath = join(root, "review-packet.json");
    await writeFile(configPath, JSON.stringify(config));
    expect(await runCli(["prepare-review", configPath, "--out", packetPath], io().sink)).toBe(0);
    expect(await runCli(["review-status", packetPath], io().sink)).toBe(0);
    const packet = createVisualReviewPacket(config);
    const verdict = createVisualReviewVerdict({ packetHash: packet.packetHash, reviewer: { kind: "external-vision", id: "fixture-reviewer" }, verdict: "PASS", findings: [] });
    await writeFile(packetPath, `${JSON.stringify(packet)}\n`);
    const verdictPath = join(root, "verdict.json"); await writeFile(verdictPath, JSON.stringify(verdict));
    expect(await runCli(["record-review", statePath, "--packet", packetPath, "--verdict", verdictPath, "--artifact", join(root, "evidence", "visual.json")], io().sink)).toBe(0);
    expect((await loadTaskState(statePath)).visualReviewStatus).toBe("passed");
  });
});

describe("activated generic operators and construction kit", () => {
  test("executes declared section, landmark, connectivity, repeat, and attachment operators", () => {
    const oracle = createGenericFixture();
    const wheels = repeatParts(2, 1, (index) => {
      const mesh = createFitting(`roller-${index}`, createWheel(0.2, 0.1)); mesh.userData.semanticRole = "roller"; return mesh;
    });
    oracle.add(wheels);
    const candidate = oracle.clone(true);
    const report = evaluateGenericProfile(snapshotScene(oracle), snapshotScene(candidate), {
      requiredSemantics: ["primary"], criticalSemantics: ["identity-fitting"],
      attachments: [{ child: "attachment", parent: "primary", maxGap: 0.01 }],
      sections: [{ id: "mid", axis: "z", fraction: 0.5, tolerance: 0.01 }],
      landmarks: [{ semanticId: "identity-fitting", tolerance: 0.01 }],
      connectivity: [{ semanticId: "primary", maxIslands: 1 }], repeats: [{ role: "roller", axis: "z", tolerance: 0.01 }],
    });
    expect(report.passed).toBe(true);
  });

  test("constructs the optional hard-surface vocabulary", () => {
    expect(createPlate(1, 2, 0.1).isBufferGeometry).toBe(true);
    expect(createPrism(1, 1, 2, 0.2).isBufferGeometry).toBe(true);
    expect(createFrustum(1, 0.5, 2).isBufferGeometry).toBe(true);
    expect(createRadialLoftGeometry([{ y: 0, radius: 1 }, { y: 1, radius: 0.5 }]).isBufferGeometry).toBe(true);
    expect(createTube(0.1, 2).isBufferGeometry).toBe(true);
    expect(createTrackCourseGeometry(5, 2, 0.2, 0.5).isBufferGeometry).toBe(true);
    expect(() => createPlate(0, 1, 1)).toThrow(/positive/);
    expect(() => createLoftGeometry([])).toThrow(/at least two/);
    expect(() => createPrism(1, 1, 1, 2)).toThrow(/invalid/);
    expect(() => createFrustum(0, 1, 1)).toThrow(/invalid/);
    expect(() => createRadialLoftGeometry([{ y: 0, radius: 1 }])).toThrow(/invalid/);
    expect(() => createTube(0, 1)).toThrow(/invalid/);
    expect(() => repeatParts(0, 1, () => new THREE.Group())).toThrow(/invalid/);
    expect(() => createTrackCourseGeometry(1, 1, 1, 1)).toThrow(/invalid/);
    expect(() => createFitting("", new THREE.BoxGeometry())).toThrow(/semantic/);
  });

  test("samples real tank pose controls", async () => {
    const root = createTankFixture();
    const turret = root.getObjectByName("turret-pivot")!;
    const gun = root.getObjectByName("gun-pivot")!;
    const result = await evaluateCandidateWithPoses({ oracle: createTankFixture(), candidate: { root, setPose: ({ turretYaw, gunElevation }) => { turret.rotation.y = turretYaw; gun.rotation.x = gunElevation; root.updateMatrixWorld(true); } }, profile: "tank" });
    expect(result.articulation.passed).toBe(true);
  });
});

describe("upstream drift inspector", () => {
  afterEach(() => vi.unstubAllGlobals());
  test("reports pinned and changed repositories without modifying them", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes("compare") ? { files: [{ filename: "tools/track-system-audit.mjs" }] } : { sha: url.includes("Claude-of-Tanks") ? "b".repeat(40) : url.includes("img2threejs") ? "d6673386f89673a58736f8d398dd16ece67874f5" : "ea8c5e7e22134ac57984d67a2cdc7c29c7c4ba90" } })));
    const result = await inspectAllUpstreamDrift();
    expect(result[0]).toMatchObject({ changed: true, relevantChangedPaths: ["tools/track-system-audit.mjs"] });
    expect(result[1]?.changed).toBe(false);
  });
});

describe("fail-closed validation branches", () => {
  test("uses stable material diagnostics instead of runtime UUIDs", () => {
    const first = new THREE.MeshStandardMaterial({ color: 0x445566, roughness: 0.4, metalness: 0.2 });
    const second = new THREE.MeshStandardMaterial({ color: 0x445566, roughness: 0.4, metalness: 0.2 });
    expect(first.uuid).not.toBe(second.uuid);
    expect(materialDiagnosticKey(first)).toBe(materialDiagnosticKey(second));
    second.roughness = 0.8;
    expect(materialDiagnosticKey(first)).not.toBe(materialDiagnosticKey(second));
  });

  test("rejects invalid frames, caches, contracts, packets, and verdicts", () => {
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number], size: [1, 1, 1] as [number, number, number], center: [0.5, 0.5, 0.5] as [number, number, number] };
    expect(() => deriveCanonicalFrame(bounds, 0)).toThrow(/positive/);
    expect(() => derivativeCacheKey({ sourceHash: "", preparedHash: "p", profileContractHash: "c", measurementVersion: "v", cameraFrameHash: "f", renderConfigHash: "r" })).toThrow(/sourceHash/);
    expect(createDerivativeCacheEntry({ sourceHash: "s", preparedHash: "p", profileContractHash: "c", measurementVersion: "v", cameraFrameHash: "f", renderConfigHash: "r" }, 1).value).toBe(1);
    expect(validateProfileContract(null).valid).toBe(false);
    expect(validateProfileContract({ schemaVersion: 1, id: "bad", phases: [], gates: [], operators: [] }).errors.length).toBeGreaterThan(2);
    expect(() => createVisualReviewPacket({ oracleHash: "o", candidateHash: "c", profile: "generic", profileContractHash: "h", styleHash: "h", deterministicArtifactHash: "h", captures: [], comparisonBoardHashes: [], turntableHashes: [], articulationArtifactHash: "h", regionEvidence: { status: "unavailable", reason: "semantic IDs invalid" } })).toThrow(/requires/);
    expect(() => createVisualReviewVerdict({ packetHash: "x", reviewer: { kind: "external-vision", id: "" }, verdict: "PASS", findings: [] })).toThrow(/identity/);
    expect(() => createVisualReviewVerdict({ packetHash: "x", reviewer: { kind: "external-vision", id: "reviewer" }, verdict: "PASS", findings: [{ criterion: "x", evidence: "x", severity: "major", regionView: "hero", expectedCorrection: "fix", reopenPhase: "primary-mass" }] })).toThrow(/contradicts/);
    const hash = "a".repeat(64);
    const packet = createVisualReviewPacket({ oracleHash: "o", candidateHash: "c", profile: "generic", profileContractHash: hash, styleHash: hash, deterministicArtifactHash: hash, captures: [{ path: "x", sha256: hash, pass: "beauty", cameraId: "hero" }], comparisonBoardHashes: [hash], turntableHashes: [hash], articulationArtifactHash: hash, regionEvidence: { status: "unavailable", reason: "semantic IDs invalid" } });
    const verdict = createVisualReviewVerdict({ packetHash: "stale", reviewer: { kind: "external-vision", id: "reviewer" }, verdict: "PASS", findings: [] });
    expect(() => verifyVisualReviewVerdict(packet, verdict)).toThrow(/stale/);
  });
});

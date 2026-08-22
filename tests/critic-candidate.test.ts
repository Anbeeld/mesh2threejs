import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  auditCandidateSource,
  awaitingVisualReview,
  canonicalJson,
  createDeterministicReplayPacket,
  createVisualReviewPacket,
  loadCandidateModule,
  loadCandidateRuntime,
  fingerprintScene,
  replayDeterministicRows,
  sha256,
  verifyVisualReviewPacketFiles,
  verifyVisualReviewPacket,
} from "../src/index.js";

describe("canonical procedural candidate", () => {
  test("loads an independently authored Three.js factory module", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-candidate-"));
    const path = join(directory, "candidate.mjs");
    await writeFile(path, `import * as THREE from ${JSON.stringify(new URL("../node_modules/three/build/three.module.js", import.meta.url).href)}; export function createCandidate(){ return new THREE.Group(); }`);
    const candidate = await loadCandidateModule(path);
    expect(candidate.isObject3D).toBe(true);
    const first = await loadCandidateRuntime(path);
    const second = await loadCandidateRuntime(path);
    expect(first.sourceHash).toBe(second.sourceHash);
    expect(fingerprintScene(first.root)).toBe(fingerprintScene(second.root));
  });

  test("rejects oracle embedding and topology dumps", () => {
    expect(auditCandidateSource("export function createCandidate() { return new THREE.Group(); }").passed).toBe(true);
    expect(auditCandidateSource("new GLTFLoader().load('oracle.glb')").passed).toBe(false);
    expect(auditCandidateSource(`const positions = [${Array.from({ length: 3000 }, (_, index) => index).join(",")}];`).passed).toBe(false);
    expect(auditCandidateSource("const oracle = 'data:model/gltf-binary;base64,AAAA'").findings[0]?.code).toBe("embedded-oracle");
  });
});

describe("deterministic replay and visual authority", () => {
  test("replays objective rows without presenting itself as visual review", () => {
    const packet = createDeterministicReplayPacket({
      candidateHash: "candidate-a",
      oracleHash: "oracle-a",
      rows: [{ code: "dimensions.depth", passed: false, severity: "critical", message: "wrong depth" }],
    });
    expect(replayDeterministicRows(packet)).toMatchObject({ kind: "deterministic-replay", passed: false, failedCodes: ["dimensions.depth"] });
  });

  test("keeps a complete immutable packet waiting when no external vision reviewer exists", () => {
    const hash = "a".repeat(64);
    const packet = createVisualReviewPacket({
      candidateHash: "candidate-a",
      oracleHash: "oracle-a",
      profile: "generic",
      profileContractHash: hash,
      styleHash: hash,
      deterministicArtifactHash: hash,
      captures: [{ path: "beauty-front.png", sha256: hash, pass: "beauty", cameraId: "front" }],
      comparisonBoardHashes: [hash],
      turntableHashes: [hash],
      articulationArtifactHash: hash,
      regionEvidence: { status: "available", semanticArtifactHash: hash },
      files: ["capture", "comparison-board", "turntable", "deterministic", "style", "articulation", "region"].map((role) => ({ path: "beauty-front.png", sha256: hash, role })) as never,
    });
    expect(awaitingVisualReview(packet).status).toBe("awaiting-visual-review");
    expect(() => verifyVisualReviewPacket({ ...packet, schemaVersion: 2 } as unknown as typeof packet)).toThrow(/schema/);
    const invalid = { ...packet, files: [] };
    const { packetHash: _oldHash, ...payload } = invalid;
    invalid.packetHash = sha256(canonicalJson(payload));
    expect(() => verifyVisualReviewPacket(invalid)).toThrow(/referenced files/);
  });

  test("reopens every referenced file when validating a review packet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-review-files-"));
    const path = join(directory, "capture.png");
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(path, bytes);
    const hash = sha256(bytes);
    const packet = createVisualReviewPacket({
      candidateHash: "candidate-a", oracleHash: "oracle-a", profile: "generic", profileContractHash: hash,
      styleHash: hash, deterministicArtifactHash: hash,
      captures: [{ path, sha256: hash, pass: "beauty", cameraId: "front" }], comparisonBoardHashes: [hash], turntableHashes: [hash], articulationArtifactHash: hash,
      regionEvidence: { status: "available", semanticArtifactHash: hash },
      files: ["capture", "comparison-board", "turntable", "deterministic", "style", "articulation", "region"].map((role) => ({ path, sha256: hash, role })) as never,
    });
    await expect(verifyVisualReviewPacketFiles(packet)).resolves.toBeUndefined();
    await expect(verifyVisualReviewPacketFiles(packet, join(directory, "workspace"))).rejects.toThrow(/escapes/);
    await writeFile(path, Buffer.from("changed"));
    await expect(verifyVisualReviewPacketFiles(packet)).rejects.toThrow(/changed|incorrect/);
  });
});

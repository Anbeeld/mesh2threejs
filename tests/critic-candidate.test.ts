import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  auditCandidateSource,
  awaitingVisualReview,
  createDeterministicReplayPacket,
  createVisualReviewPacket,
  loadCandidateModule,
  loadCandidateRuntime,
  fingerprintScene,
  replayDeterministicRows,
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
    });
    expect(awaitingVisualReview(packet).status).toBe("awaiting-visual-review");
  });
});

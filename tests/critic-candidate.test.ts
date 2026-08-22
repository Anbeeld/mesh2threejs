import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertCriticVerdictFresh,
  auditCandidateSource,
  createCriticPacket,
  evaluateCriticPacket,
  loadCandidateModule,
} from "../src/index.js";

describe("canonical procedural candidate", () => {
  test("loads an independently authored Three.js factory module", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-candidate-"));
    const path = join(directory, "candidate.mjs");
    await writeFile(path, `import * as THREE from ${JSON.stringify(new URL("../node_modules/three/build/three.module.js", import.meta.url).href)}; export function createCandidate(){ return new THREE.Group(); }`);
    const candidate = await loadCandidateModule(path);
    expect(candidate.isObject3D).toBe(true);
  });

  test("rejects oracle embedding and topology dumps", () => {
    expect(auditCandidateSource("export function createCandidate() { return new THREE.Group(); }").passed).toBe(true);
    expect(auditCandidateSource("new GLTFLoader().load('oracle.glb')").passed).toBe(false);
    expect(auditCandidateSource(`const positions = [${Array.from({ length: 3000 }, (_, index) => index).join(",")}];`).passed).toBe(false);
    expect(auditCandidateSource("const oracle = 'data:model/gltf-binary;base64,AAAA'").findings[0]?.code).toBe("embedded-oracle");
  });
});

describe("hash-bound critic", () => {
  test("issues ordered findings and cannot bless deterministic failures", () => {
    const packet = createCriticPacket({
      candidateHash: "candidate-a",
      oracleHash: "oracle-a",
      profile: "generic",
      style: "low-poly-faithful",
      deterministicPassed: false,
      rows: [{ code: "dimensions.depth", passed: false, severity: "critical", message: "wrong depth" }],
      captures: [],
      visualFindings: [],
    });
    const verdict = evaluateCriticPacket(packet);
    expect(verdict.verdict).toBe("FAIL");
    expect(verdict.findings[0]?.criterion).toBe("dimensions.depth");
    expect(() => assertCriticVerdictFresh(verdict, "candidate-b")).toThrow(/stale/);
  });

  test("fails a deterministic pass when calibrated visual inspection finds fabrication or style defects", () => {
    const packet = createCriticPacket({
      candidateHash: "candidate-a",
      oracleHash: "oracle-a",
      profile: "generic",
      style: "low-poly-faithful",
      deterministicPassed: true,
      rows: [],
      captures: ["beauty-front.png", "normal-front.png"],
      visualFindings: [{
        criterion: "fabrication.readability",
        evidence: "front beauty view shows an unsupported floating bracket",
        severity: "major",
        affectedRegionView: "front / upper bracket",
        expectedCorrection: "seat the bracket on its parent surface",
        reopenDeterministicGate: true,
      }],
    });
    expect(evaluateCriticPacket(packet).verdict).toBe("FAIL");
  });
});

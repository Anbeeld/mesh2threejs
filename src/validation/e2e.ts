import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyticalGeneric, analyticalTank } from "../fixtures/analytical.js";
import { evaluateCandidate } from "../core/orchestration.js";
import { assertCriticVerdictFresh, createCriticPacket, runIndependentCritic } from "../core/critic.js";
import { createComparisonBoard, createTurntable, rasterizeCapture, standardRenderProfile, writeCapturePng } from "../core/render.js";
import { snapshotScene } from "../core/geometry.js";
import { auditCandidateSource, loadCandidateModule } from "../core/candidate.js";
import { bindCandidate, bindOracle, certifyState, createTaskState, recordEvidence } from "../core/state.js";
import type { CapturePass } from "../types.js";

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-e2e-"));
  try {
    const cases = [
      { id: "tank", profile: "tank" as const, oracle: analyticalTank(), candidatePath: resolve("examples/tank/candidate.mjs") },
      { id: "generic", profile: "generic" as const, oracle: analyticalGeneric(), candidatePath: resolve("examples/generic/candidate.mjs") },
    ];
    const profile = standardRenderProfile({ width: 96, height: 96 });
    const passes: CapturePass[] = ["beauty", "alpha-silhouette", "semantic-id", "depth", "normal", "roughness-material-id"];
    for (const item of cases) {
      const audit = auditCandidateSource(await readFile(item.candidatePath, "utf8"));
      if (!audit.passed) throw new Error(`${item.id} candidate source audit failed: ${audit.findings.map((finding) => finding.code).join("; ")}`);
      const candidate = await loadCandidateModule(item.candidatePath);
      const evaluation = evaluateCandidate({ oracle: item.oracle, candidate, profile: item.profile });
      if (!evaluation.passed) throw new Error(`${item.id} deterministic/style evaluation failed: ${JSON.stringify(evaluation)}`);
      const camera = { id: "hero", projection: "perspective" as const, position: [8, 5, 8] as const, target: [0, 0.8, 0] as const };
      const oracleSnapshot = snapshotScene(item.oracle);
      const candidateSnapshot = snapshotScene(candidate);
      const capturePaths: string[] = [];
      for (const pass of passes) {
        const oracleFrame = rasterizeCapture(oracleSnapshot, profile, camera, pass);
        const candidateFrame = rasterizeCapture(candidateSnapshot, profile, camera, pass);
        const oraclePath = join(directory, item.id, `oracle-${pass}.png`);
        const candidatePath = join(directory, item.id, `candidate-${pass}.png`);
        await writeCapturePng(oraclePath, oracleFrame);
        await writeCapturePng(candidatePath, candidateFrame);
        capturePaths.push(oraclePath, candidatePath);
        if (pass === "beauty") await createComparisonBoard(join(directory, item.id, "board.png"), oracleFrame, candidateFrame);
      }
      const turntable = await createTurntable(join(directory, item.id, "turntable"), candidateSnapshot, profile, { frames: 8 });
      const packet = createCriticPacket({
        candidateHash: evaluation.candidateHash,
        oracleHash: evaluation.oracleHash,
        profile: item.profile,
        style: "low-poly-faithful",
        deterministicPassed: evaluation.passed,
        rows: [...evaluation.deterministic.rows, ...evaluation.style.rows],
        captures: [...capturePaths, ...turntable],
      });
      const verdict = await runIndependentCritic(packet);
      if (verdict.verdict !== "PASS" || !verdict.independentProcess) throw new Error(`${item.id} critic failed`);
      assertCriticVerdictFresh(verdict, evaluation.candidateHash);
      let state = createTaskState({ taskId: `e2e-${item.id}`, profile: item.profile, style: "low-poly-faithful" });
      state = bindCandidate(bindOracle(state, evaluation.oracleHash), evaluation.candidateHash);
      const evidence = [
        ["registration", "registration", "registration.json"],
        ["deterministic", "deterministic-gate", "gate.json"],
        ["style", "style", "style.json"],
        ["complexity", "complexity", "style.json"],
        ["articulation", "articulation", item.profile === "tank" ? "articulation.json" : "articulation-not-required.json"],
        ["critic", "critic", "verdict.json"],
        ["turntable", "turntable", "turntable/"],
      ] as const;
      for (const [id, kind, artifact] of evidence) {
        state = recordEvidence(state, { id, kind, phase: id, artifact, passed: true, oracleHash: evaluation.oracleHash, candidateHash: evaluation.candidateHash });
      }
      const certified = certifyState(state);
      if (certified.status !== "certified") throw new Error(`${item.id} state did not certify`);
      process.stdout.write(`${item.id}: deterministic=${evaluation.deterministic.score.toFixed(1)} style=${evaluation.style.score.toFixed(1)} critic=${verdict.verdict} state=${certified.status} captures=${capturePaths.length} turntable=${turntable.length}\n`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();

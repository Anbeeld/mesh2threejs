import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { analyticalGeneric, analyticalTank } from "../fixtures/analytical.js";
import { evaluateCandidateWithPoses } from "../core/orchestration.js";
import { awaitingVisualReview, createVisualReviewPacket } from "../core/review.js";
import { createComparisonBoard, createTurntable, rasterizeCapture, standardRenderProfile, writeCapturePng } from "../core/render.js";
import { snapshotScene } from "../core/geometry.js";
import { auditCandidateModule, loadCandidateRuntime } from "../core/candidate.js";
import { sha256 } from "../core/hashing.js";
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
      const audit = await auditCandidateModule(item.candidatePath);
      if (!audit.passed) throw new Error(`${item.id} candidate source audit failed: ${audit.findings.map((finding) => finding.code).join("; ")}`);
      const candidate = await loadCandidateRuntime(item.candidatePath);
      const evaluation = await evaluateCandidateWithPoses({ oracle: item.oracle, candidate, profile: item.profile });
      if (!evaluation.passed) throw new Error(`${item.id} deterministic/style evaluation failed: ${JSON.stringify(evaluation)}`);
      const camera = { id: "hero", projection: "perspective" as const, position: [8, 5, 8] as const, target: [0, 0.8, 0] as const };
      const oracleSnapshot = snapshotScene(item.oracle);
      const candidateSnapshot = snapshotScene(candidate.root);
      const capturePaths: Array<{ path: string; pass: CapturePass }> = [];
      let boardPath = "";
      for (const pass of passes) {
        const oracleFrame = rasterizeCapture(oracleSnapshot, profile, camera, pass);
        const candidateFrame = rasterizeCapture(candidateSnapshot, profile, camera, pass);
        const oraclePath = join(directory, item.id, `oracle-${pass}.png`);
        const candidatePath = join(directory, item.id, `candidate-${pass}.png`);
        await writeCapturePng(oraclePath, oracleFrame);
        await writeCapturePng(candidatePath, candidateFrame);
        capturePaths.push({ path: oraclePath, pass }, { path: candidatePath, pass });
        if (pass === "beauty") { boardPath = join(directory, item.id, "board.png"); await createComparisonBoard(boardPath, oracleFrame, candidateFrame); }
      }
      const turntable = await createTurntable(join(directory, item.id, "turntable"), candidateSnapshot, profile, { frames: 8 });
      const packet = createVisualReviewPacket({
        candidateHash: evaluation.candidateHash,
        oracleHash: evaluation.oracleHash,
        profile: item.profile,
        profileContractHash: sha256(item.profile),
        styleHash: sha256("low-poly-faithful"),
        deterministicArtifactHash: sha256(JSON.stringify(evaluation)),
        captures: await Promise.all(capturePaths.map(async (capture) => ({ path: capture.path, sha256: sha256(await readFile(capture.path)), pass: capture.pass, cameraId: "hero" }))),
        comparisonBoardHashes: [sha256(await readFile(boardPath))],
        turntableHashes: await Promise.all(turntable.map(async (path) => sha256(await readFile(path)))),
        articulationArtifactHash: sha256(JSON.stringify(evaluation.articulation)),
        regionEvidence: { status: "available", semanticArtifactHash: sha256("analytical-semantic-ids") },
      });
      const review = awaitingVisualReview(packet);
      process.stdout.write(`${item.id}: deterministic=${evaluation.deterministic.score.toFixed(1)} style=${evaluation.style.score.toFixed(1)} articulation=${evaluation.articulation.score.toFixed(1)} review=${review.status} captures=${capturePaths.length} turntable=${turntable.length}\n`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();

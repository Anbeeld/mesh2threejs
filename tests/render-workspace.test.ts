import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createComparisonBoard,
  createTurntable,
  initializeWorkspace,
  rasterizeCapture,
  snapshotScene,
  standardRenderProfile,
  writeCapturePng,
} from "../src/index.js";
import { createGenericFixture } from "./helpers/scenes.js";

describe("diagnostic render and workspace contract", () => {
  test("emits all six diagnostic passes as PNG evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-render-"));
    const snapshot = snapshotScene(createGenericFixture());
    const profile = standardRenderProfile({ width: 64, height: 64 });
    const camera = { id: "front", projection: "orthographic" as const, position: [0, 2, 8] as const, target: [0, 0, 0] as const };
    const ids = ["beauty", "alpha-silhouette", "semantic-id", "depth", "normal", "roughness-material-id"] as const;
    for (const id of ids) {
      const frame = rasterizeCapture(snapshot, profile, camera, id);
      const path = join(directory, `${id}.png`);
      await writeCapturePng(path, frame);
      expect((await readFile(path)).subarray(1, 4).toString()).toBe("PNG");
    }
  });

  test("creates comparison boards and turntables bound to one profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-board-"));
    const snapshot = snapshotScene(createGenericFixture());
    const profile = standardRenderProfile({ width: 48, height: 48 });
    const camera = { id: "front", projection: "orthographic" as const, position: [0, 2, 8] as const, target: [0, 0, 0] as const };
    const oracle = rasterizeCapture(snapshot, profile, camera, "beauty");
    const candidate = rasterizeCapture(snapshot, profile, camera, "beauty");
    const board = await createComparisonBoard(join(directory, "board.png"), oracle, candidate);
    const turntable = await createTurntable(join(directory, "turntable"), snapshot, profile, { frames: 8 });
    expect(board.width).toBe(96);
    expect(turntable).toHaveLength(8);
  });

  test("initializes durable workspace manifests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-workspace-"));
    const result = await initializeWorkspace(directory, {
      id: "fixture",
      goal: "reconstruct fixture",
      profile: "generic",
      style: "low-poly-faithful",
      oracleManifest: "oracle/manifest.json",
      candidateModule: "candidate/candidate.mjs",
      certification: "oracle-relative",
    });
    expect(result.directories).toEqual(expect.arrayContaining(["oracle", "candidate", "evidence"]));
    expect(JSON.parse(await readFile(join(directory, "task.json"), "utf8")).id).toBe("fixture");
  });
});

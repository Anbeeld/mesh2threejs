import { describe, expect, test } from "vitest";
import { analyticalTank } from "../src/fixtures/analytical.js";
import { evaluateCandidateWithPoses, PerformanceRecorder } from "../src/index.js";

describe("operator performance instrumentation", () => {
  test("records profile hotspots and each articulation sample in machine-readable form", async () => {
    const oracle = analyticalTank();
    const candidate = analyticalTank();
    const performance = new PerformanceRecorder();
    await evaluateCandidateWithPoses({ oracle, profile: "tank", performance, candidate: {
      root: candidate,
      sourceHash: "instrumented-source",
      setPose: (pose) => {
        const turret = candidate.getObjectByName("turret-pivot");
        const gun = candidate.getObjectByName("gun-pivot");
        if (turret) turret.rotation.y = pose.turretYaw ?? 0;
        if (gun) gun.rotation.x = pose.gunElevation ?? 0;
      },
    } });
    const report = performance.report();
    const names = report.operators.map((row) => row.operator);
    expect(report).toMatchObject({ schemaVersion: 1, peakObservedRssBytes: expect.any(Number) });
    expect(names).toEqual(expect.arrayContaining(["oracle-snapshot-construction", "candidate-snapshot-construction", "whole-hull-turret-silhouette", "fourteen-hull-stations", "running-gear-matching", "track-diagnostics", "watertightness-connected-islands", "neutral-style-evaluation"]));
    expect(names.filter((name) => name.startsWith("articulation."))).toHaveLength(6);
    expect(report.operators.every((row) => row.elapsedMs >= 0 && row.peakObservedRssBytes > 0)).toBe(true);
  });
});

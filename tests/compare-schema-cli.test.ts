import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  lowPolyFaithful,
  runCli,
  scoreSilhouetteCurves,
  validateStyleContract,
  validateTaskManifest,
  validateOracleManifest,
  validateRenderProfile,
  standardRenderProfile,
  summarizeCalibration,
} from "../src/index.js";

describe("CoT-derived curve scoring", () => {
  const exact = [[-1, 1, -1], [0, 1.5, -1], [1, 1, -1]] as const;

  test("scores exact curves at 100 and exposes worst actionable columns", () => {
    const score = scoreSilhouetteCurves([...exact], [...exact], 2.5);
    expect(score.score).toBe(100);
    expect(score.worst).toHaveLength(3);
  });

  test("hull-pinned registration prevents a displaced turret self-registering", () => {
    const displaced = exact.map((point) => [point[0] + 0.4, point[1], point[2]] as [number, number, number]);
    const selfRegistered = scoreSilhouetteCurves([...exact], displaced, 2.5);
    const hullPinned = scoreSilhouetteCurves([...exact], displaced, 2.5, { dAlong: 0, vertical: 0 });
    expect(selfRegistered.score).toBe(100);
    expect(hullPinned.score).toBeLessThan(90);
    expect(hullPinned.coverPct).toBeGreaterThan(0);
  });

  test("penalizes excess coverage bidirectionally", () => {
    const excess = [[-2, 1, -1], ...exact, [2, 1, -1]] as [number, number, number][];
    expect(scoreSilhouetteCurves([...exact], excess, 2.5, { dAlong: 0, vertical: 0 }).coverPct).toBeGreaterThan(0);
  });
});

describe("machine-readable contracts", () => {
  test("validates the canonical style and rejects geometry-relaxing contracts", () => {
    expect(validateStyleContract(lowPolyFaithful).valid).toBe(true);
    expect(validateStyleContract({
      ...lowPolyFaithful,
      featureSizePolicy: { minimum: 0.05, unit: "object-unit", appliesTo: ["antenna-*"] },
    }).valid).toBe(true);
    expect(validateStyleContract({
      ...lowPolyFaithful,
      featureSizePolicy: { minimum: 0.05, unit: "pixels", appliesTo: ["antenna-*"] },
    }).valid).toBe(false);
    expect(validateStyleContract({ ...lowPolyFaithful, preserve: { ...lowPolyFaithful.preserve, macroGeometry: false } }).valid).toBe(false);
  });

  test("requires explicit certification status in task manifests", () => {
    expect(validateTaskManifest({
      schemaVersion: 1,
      id: "x",
      goal: "reconstruct",
      profile: "generic",
      style: "low-poly-faithful",
      oracleManifest: "oracle/manifest.json",
      candidateModule: "candidate/candidate.mjs",
      certification: "oracle-relative",
    }).valid).toBe(true);
    expect(validateTaskManifest({ schemaVersion: 1, id: "x" }).valid).toBe(false);
  });

  test("validates oracle and six-pass render contracts", () => {
    expect(validateOracleManifest({ schemaVersion: 1 }).valid).toBe(false);
    expect(validateRenderProfile(standardRenderProfile()).valid).toBe(true);
  });

  test("records evaluator disagreement instead of hiding it", () => {
    expect(summarizeCalibration([]).accuracy).toBe(1);
    expect(summarizeCalibration([{ id: "disagree", human: "PASS", machine: "FAIL" }])).toEqual({ total: 1, agreements: 0, disagreements: ["disagree"], accuracy: 0 });
  });
});

describe("CLI", () => {
  test("initializes a resumable workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-cli-"));
    const output: string[] = [];
    const code = await runCli([
      "init", "--workspace", directory, "--id", "cli-fixture", "--goal", "reconstruct",
      "--profile", "generic", "--oracle", "oracle/manifest.json", "--candidate", "candidate/candidate.mjs",
    ], { stdout: (value) => output.push(value), stderr: (value) => output.push(value) });
    expect(code).toBe(0);
    expect(JSON.parse(await readFile(join(directory, "task.json"), "utf8")).id).toBe("cli-fixture");
    expect(output.join("\n")).toContain("cli-fixture");
    output.length = 0;
    expect(await runCli(["status", join(directory, "state.json")], { stdout: (value) => output.push(value), stderr: (value) => output.push(value) })).toBe(0);
    expect(JSON.parse(output[0]!).activePhase).toBe("oracle-registration");
    output.length = 0;
    expect(await runCli(["next", join(directory, "state.json")], { stdout: (value) => output.push(value), stderr: (value) => output.push(value) })).toBe(0);
    expect(JSON.parse(output[0]!).route).toBe("onboard-oracle");
  });

  test("fails closed on unknown commands", async () => {
    expect(await runCli(["invent"], { stdout: () => undefined, stderr: () => undefined })).toBe(2);
  });

  test("routes through the CLI and rejects missing route text", async () => {
    const output: string[] = [];
    expect(await runCli(["route", "tracked", "armored", "vehicle"], { stdout: (value) => output.push(value), stderr: () => undefined })).toBe(0);
    expect(JSON.parse(output[0]!).profile).toBe("tank");
    expect(await runCli(["route"], { stdout: () => undefined, stderr: () => undefined })).toBe(2);
  });
});

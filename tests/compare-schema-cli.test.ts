import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  lowPolyFaithful,
  runCli,
  scoreSilhouetteCurves,
  validateStyleContract,
  validateProjectManifest,
  validateReferenceIndex,
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

  test("validates stable project configuration without accepting volatile task fields", () => {
    expect(validateProjectManifest({
      schemaVersion: 1,
      id: "x",
      goal: "reconstruct",
      profile: "generic",
      style: "low-poly-faithful",
      oracle: "refs/oracle/source.glb",
      images: [],
      documents: [],
      model: "model/model.mjs",
      certification: "oracle-relative",
      referenceMode: "copy",
      portable: true,
    }).valid).toBe(true);
    expect(validateProjectManifest({ schemaVersion: 1, id: "x", attempts: [] }).valid).toBe(false);
    expect(validateReferenceIndex({
      schemaVersion: 1,
      records: [{ kind: "oracle", mode: "copy", operationalPath: "refs/oracle/source.glb", originalPath: "C:/source.glb", sha256: "a".repeat(64) }],
    }).valid).toBe(true);
    expect(validateReferenceIndex({ schemaVersion: 1, records: [{ kind: "oracle", operationalPath: "../source.glb" }] }).valid).toBe(false);
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
    const workspace = join(directory, "workspace");
    const oracle = join(directory, "fixture.glb");
    const image = join(directory, "front.png");
    await writeFile(oracle, "oracle");
    await writeFile(image, "image");
    const output: string[] = [];
    const code = await runCli([
      "init", workspace, "--id", "cli-fixture", "--goal", "reconstruct",
      "--profile", "generic", "--ref", oracle, "--ref", image,
    ], { stdout: (value) => output.push(value), stderr: (value) => output.push(value) });
    expect(code).toBe(0);
    expect(JSON.parse(await readFile(join(workspace, "project.json"), "utf8"))).toMatchObject({ id: "cli-fixture", oracle: "refs/oracle/fixture.glb", images: ["refs/images/front.png"] });
    expect(output.join("\n")).toContain("cli-fixture");
    output.length = 0;
    expect(await runCli(["status", workspace], { stdout: (value) => output.push(value), stderr: (value) => output.push(value) })).toBe(0);
    expect(JSON.parse(output[0]!).activePhase).toBe("oracle-registration");
    output.length = 0;
    expect(await runCli(["next", workspace], { stdout: (value) => output.push(value), stderr: (value) => output.push(value) })).toBe(0);
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

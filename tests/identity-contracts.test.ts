import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { beforeAll, describe, expect, test } from "vitest";
import {
  auditCandidateModule,
  createVisualReviewVerdict,
  createEvaluationIdentity,
  evaluationIdentityHash,
  initializeWorkspace,
  inspectCandidateIdentity,
  loadStyleContract,
  rebindWorkspace,
  resumeWorkspace,
  runCli,
  workspaceGateOutcome,
} from "../src/index.js";

function minimalGlb(): Buffer {
  const positions = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, -1, -1, 1, 1, -1, -1, 1, -1]);
  const bin = Buffer.from(positions.buffer);
  const json = {
    asset: { version: "2.0" }, buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 6, type: "VEC3", min: [-1, -1, -1], max: [1, 1, -1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0, name: "Object_0" }], scenes: [{ nodes: [0] }], scene: 0,
  };
  let jsonBytes = Buffer.from(JSON.stringify(json));
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 0x20)]);
  const binBytes = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]);
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const output = Buffer.alloc(total);
  output.write("glTF", 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(total, 8); output.writeUInt32LE(jsonBytes.length, 12); output.writeUInt32LE(0x4e4f534a, 16); jsonBytes.copy(output, 20);
  const offset = 20 + jsonBytes.length;
  output.writeUInt32LE(binBytes.length, offset); output.writeUInt32LE(0x004e4942, offset + 4); binBytes.copy(output, offset + 8);
  return output;
}

const candidateSource = (behavior: string): string => `import * as THREE from "three";
export function createCandidate(){
  const root=new THREE.Group();
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshStandardMaterial({color:new THREE.Color(0.5,0.5,0.5),roughness:0.7,metalness:0}));
  mesh.position.set(0,1,-1); mesh.name="primary"; mesh.userData.semanticId="primary"; root.add(mesh);
  return { root, setPose(){ ${behavior} } };
}\n`;

async function buildReviewReadyWorkspace(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-live-binding-"));
  const root = join(parent, "workspace");
  const source = join(parent, "source.glb");
  await writeFile(source, minimalGlb());
  const messages: string[] = [];
  const sink = { stdout: (value: string) => messages.push(value), stderr: (value: string) => messages.push(value) };
  expect(await runCli(["init", root, "--id", "live", "--goal", "fixture", "--profile", "generic", "--oracle", source], sink)).toBe(0);
  const onboard = join(parent, "onboard.json");
  await writeFile(onboard, JSON.stringify({ id: "live", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed", coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1, semanticMap: { "node:0": "primary" }, articulationMap: {}, normalization: { translation: [0, 1, 0], rotationEuler: [0, 0, 0], scale: 1 }, authoritativeDimensions: null, dimensionSources: [] }));
  expect(await runCli(["onboard", root, "--config", onboard], sink)).toBe(0);
  const registration = join(parent, "registration.json");
  await writeFile(registration, JSON.stringify({ forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, requiredSemantics: ["primary"], requiredPivots: [], tolerance: 1e-6 }));
  expect(await runCli(["register", root, "--config", registration], sink)).toBe(0);
  expect(await runCli(["lock", root], sink)).toBe(0);
  const model = join(root, "model", "model.mjs");
  await writeFile(model, candidateSource("void 0;"));
  expect(await runCli(["gate", root, "--global"], sink)).toBe(0);
  expect(await runCli(["render", root], sink)).toBe(0);
  expect(await runCli(["prepare-review", root], sink)).toBe(0);
  return root;
}

let reviewReadyTemplate: string;

async function reviewReadyWorkspace(): Promise<{ root: string; model: string; packet: string }> {
  const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-live-binding-copy-"));
  const root = join(parent, "workspace");
  await cp(reviewReadyTemplate, root, { recursive: true });
  const model = join(root, "model", "model.mjs");
  return { root, model, packet: join(root, ".mesh2threejs", "visual-review", "review-0001", "packet.json") };
}

describe("canonical candidate and evaluation identity", () => {
  test("changes when a same-size transitive dependency changes but neutral geometry does not", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh2threejs-candidate-identity-"));
    const helper = join(root, "helper.mjs");
    const candidate = join(root, "candidate.mjs");
    await writeFile(helper, "export const marker = 'a';\n");
    await writeFile(candidate, `import * as THREE from "three"; import { marker } from "./helper.mjs"; export function createCandidate(){ void marker; return new THREE.Group(); }\n`);
    const first = await inspectCandidateIdentity(candidate);
    await writeFile(helper, "export const marker = 'b';\n");
    const second = await inspectCandidateIdentity(candidate);

    expect(first.neutralSceneHash).toBe(second.neutralSceneHash);
    expect(first.sourceHash).not.toBe(second.sourceHash);
    expect(first.candidateHash).not.toBe(second.candidateHash);
    expect(first.candidateFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: "helper.mjs", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })]));
  });

  test("executes the freshly audited transitive dependency bytes within one long-lived process", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh2threejs-transitive-execution-"));
    const helper = join(root, "helper.mjs");
    const candidate = join(root, "candidate.mjs");
    const source = `import * as THREE from "three"; import { width } from "./helper.mjs"; export function createCandidate(){ const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 1, 1), new THREE.MeshStandardMaterial()); const root = new THREE.Group(); root.add(mesh); return root; }\n`;
    await writeFile(helper, "export const width = 1;\n");
    await writeFile(candidate, source);
    const first = await inspectCandidateIdentity(candidate);

    await writeFile(helper, "export const width = 2;\n");
    const second = await inspectCandidateIdentity(candidate);

    expect(second.sourceHash).not.toBe(first.sourceHash);
    expect(second.candidateHash).not.toBe(first.candidateHash);
    const sizeOf = (scene: THREE.Object3D): number => new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3()).x;
    expect(sizeOf(first.runtime.root)).toBeCloseTo(1);
    expect(sizeOf(second.runtime.root)).toBeCloseTo(2);
    expect(second.neutralSceneHash).not.toBe(first.neutralSceneHash);
  });

  test("rejects dynamic local imports that would resolve into the removed stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh2threejs-dynamic-import-"));
    await writeFile(join(root, "helper.mjs"), "export function buildHull(){ return null; }\n");
    const candidate = join(root, "candidate.mjs");
    await writeFile(candidate, `export async function createCandidate(){ const { buildHull } = await import("./helper.mjs"); return buildHull(); }\n`);
    const audit = await auditCandidateModule(candidate);
    expect(audit.passed).toBe(false);
    expect(audit.findings.map((finding) => finding.code)).toContain("dynamic-local-import");
    await expect(inspectCandidateIdentity(candidate)).rejects.toThrow(/source audit failed/u);
  });

  test("changes when control behavior changes but neutral geometry is identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh2threejs-control-identity-"));
    const candidate = join(root, "candidate.mjs");
    const source = (setter: string) => `import * as THREE from "three"; export function createCandidate(){ const root=new THREE.Group(); const moving=new THREE.Mesh(new THREE.BoxGeometry(1,1,1)); moving.userData.semanticId="lid"; root.add(moving); return {root,setPose(pose){${setter}}}; }\n`;
    await writeFile(candidate, source("moving.rotation.x=pose.lid??0;"));
    const working = await inspectCandidateIdentity(candidate, { lid: 0 });
    await writeFile(candidate, source("void pose;"));
    const broken = await inspectCandidateIdentity(candidate, { lid: 0 });
    expect(working.neutralSceneHash).toBe(broken.neutralSceneHash);
    expect(working.candidateHash).not.toBe(broken.candidateHash);
  });

  test("hashes every decision-changing evaluation input", () => {
    const base = createEvaluationIdentity({
      evaluatorVersion: "4",
      measurementVersion: "2",
      profile: "generic",
      profileContractHash: "profile-a",
      styleContractHash: "style-a",
      subjectContractHash: null,
      certification: "oracle-relative",
      oraclePreparationHash: "preparation-a",
      preparedOracleHash: "prepared-a",
      authoritativeDimensionsHash: null,
      candidateSourceHash: "source-a",
      candidateNeutralHash: "neutral-a",
    });
    const changes = [
      { evaluatorVersion: "5" },
      { measurementVersion: "3" },
      { profileContractHash: "profile-b" },
      { styleContractHash: "style-b" },
      { subjectContractHash: "subject-b" },
      { certification: "exact-real" as const },
      { oraclePreparationHash: "preparation-b" },
      { preparedOracleHash: "prepared-b" },
      { authoritativeDimensionsHash: "dimensions-b" },
      { candidateSourceHash: "source-b" },
      { candidateNeutralHash: "neutral-b" },
    ];
    for (const change of changes) expect(evaluationIdentityHash({ ...base, ...change })).not.toBe(evaluationIdentityHash(base));
  });
});

describe("bound project and style configuration", () => {
  test("loads the selected style from its validated JSON contract and rejects unknown IDs", async () => {
    const loaded = await loadStyleContract("low-poly-faithful");
    const json = JSON.parse(await readFile(join(process.cwd(), "styles", "low-poly-faithful.json"), "utf8"));
    expect(loaded.contract).toEqual(json);
    expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/u);
    await expect(loadStyleContract("unknown-style")).rejects.toThrow(/unknown style/i);
  });

  test.each([
    ["profile", (project: Record<string, unknown>) => { project.profile = "tank"; }],
    ["style", (project: Record<string, unknown>) => { project.style = "unknown-style"; }],
    ["certification", (project: Record<string, unknown>) => { project.certification = "exact-real"; }],
    ["model", (project: Record<string, unknown>) => { project.model = "model/alternate.mjs"; }],
    ["oracle", (project: Record<string, unknown>) => { project.oracle = "refs/oracle/second.glb"; }],
    ["subject contract", (project: Record<string, unknown>) => { project.subjectContract = "refs/docs/subject-b.json"; }],
  ])("rejects %s drift from the state-bound project identity", async (_label, mutate) => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-project-identity-"));
    const sources = join(parent, "sources");
    await mkdir(sources);
    const firstOracle = join(sources, "first.glb");
    const secondOracle = join(sources, "second.glb");
    const subjectA = join(sources, "subject-a.json");
    const subjectB = join(sources, "subject-b.json");
    await writeFile(firstOracle, "first");
    await writeFile(secondOracle, "second");
    await writeFile(subjectA, JSON.stringify({ articulation: [] }));
    await writeFile(subjectB, JSON.stringify({ articulation: [{ control: "lid", moving: ["attachment"], stationary: ["primary"], samples: [0, 1] }] }));
    const root = join(parent, "workspace");
    await initializeWorkspace(root, { id: "bound", goal: "fixture", profile: "generic", oracle: firstOracle, references: [secondOracle, subjectB], subjectContract: subjectA });
    await writeFile(join(root, "model", "alternate.mjs"), "export function createCandidate(){ throw new Error('unused'); }\n");
    const projectPath = join(root, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8")) as Record<string, unknown>;
    mutate(project);
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    await expect(resumeWorkspace(root)).rejects.toThrow(/project configuration|unknown style/i);
  });
});

describe("live workspace candidate binding", () => {
  beforeAll(async () => {
    reviewReadyTemplate = await buildReviewReadyWorkspace();
  }, 120_000);

  test("propagates one evaluation and style identity through state, cache, evidence, render, and review", async () => {
    const { root, packet } = await reviewReadyWorkspace();
    const state = JSON.parse(await readFile(join(root, ".mesh2threejs", "state.json"), "utf8"));
    const cache = JSON.parse(await readFile(join(root, ".mesh2threejs", "reports", "gate-cache.json"), "utf8"));
    const styleArtifact = JSON.parse(await readFile(join(root, ".mesh2threejs", "evidence", "gate-0001", "gate-0001-style.json"), "utf8"));
    const renderManifest = JSON.parse(await readFile(join(root, ".mesh2threejs", "captures", "render-0001", "render-manifest.json"), "utf8"));
    const reviewPacket = JSON.parse(await readFile(packet, "utf8"));

    expect(state.styleContractHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(state.evaluationIdentityHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(cache.identity).toEqual(state.evaluationIdentity);
    expect(cache.candidateFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: "model.mjs", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })]));
    expect(styleArtifact).toMatchObject({ styleContractHash: state.styleContractHash, evaluationIdentityHash: state.evaluationIdentityHash });
    expect(renderManifest).toMatchObject({ styleContractHash: state.styleContractHash, evaluationIdentityHash: state.evaluationIdentityHash });
    expect(reviewPacket).toMatchObject({ schemaVersion: 4, styleContractHash: state.styleContractHash, evaluationIdentityHash: state.evaluationIdentityHash });
  }, 30_000);

  test("rejects recording a verdict after candidate source changes", async () => {
    const { root, model, packet } = await reviewReadyWorkspace();
    const reviewPacket = JSON.parse(await readFile(packet, "utf8"));
    const verdict = createVisualReviewVerdict({ packetHash: reviewPacket.packetHash, reviewer: { kind: "external-vision", id: "fixture-reviewer" }, verdict: "PASS", findings: [] });
    const verdictPath = join(root, "verdict.json");
    await writeFile(verdictPath, JSON.stringify(verdict));
    await writeFile(model, candidateSource("void 1;"));
    const output: string[] = [];
    expect(await runCli(["record-review", root, "--verdict", verdictPath], { stdout: (value) => output.push(value), stderr: (value) => output.push(value) })).toBe(2);
    expect(output.join("\n")).toMatch(/current workspace candidate differs/i);
  }, 30_000);

  test("rejects rendering after the gated candidate changes", async () => {
    const { root, model } = await reviewReadyWorkspace();
    await writeFile(model, candidateSource("void 2;"));
    const output: string[] = [];
    expect(await runCli(["render", root], { stdout: (value) => output.push(value), stderr: (value) => output.push(value) })).toBe(2);
    expect(output.join("\n")).toMatch(/differs from gated candidate/i);
  }, 30_000);

  test("checks live source identity before artifact certification", async () => {
    const { root, model, packet } = await reviewReadyWorkspace();
    const reviewPacket = JSON.parse(await readFile(packet, "utf8"));
    const verdict = createVisualReviewVerdict({ packetHash: reviewPacket.packetHash, reviewer: { kind: "external-vision", id: "fixture-reviewer" }, verdict: "PASS", findings: [] });
    const verdictPath = join(root, "verdict.json");
    await writeFile(verdictPath, JSON.stringify(verdict));
    expect(await runCli(["record-review", root, "--verdict", verdictPath], { stdout: () => undefined, stderr: () => undefined })).toBe(0);
    await writeFile(model, candidateSource("void 1;"));
    const output: string[] = [];
    expect(await runCli(["finalize", root], { stdout: (value) => output.push(value), stderr: (value) => output.push(value) })).toBe(2);
    expect(output.join("\n")).toMatch(/current workspace candidate differs/i);
  }, 30_000);

  test("explicit rebind starts a clean evidence chain for changed project configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh2threejs-rebind-"));
    await initializeWorkspace(root, { id: "rebind", goal: "fixture", profile: "generic", style: "low-poly-faithful", certification: "oracle-relative", references: [] });
    const projectPath = join(root, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.certification = "exact-real";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    await expect(resumeWorkspace(root)).rejects.toThrow(/rebind/);
    const rebound = await rebindWorkspace(root);
    expect(rebound.state).toMatchObject({ certification: "exact-real", evidence: {}, locks: {} });
    expect(rebound.state.systemDecisions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "workspace-rebind" })]));
  });

  test("separates active-phase success from unfinished future phases", () => {
    const evaluation = { passed: false, phaseGates: { hull: { passed: true }, turret: { passed: false } } } as never;
    expect(workspaceGateOutcome(evaluation, "hull")).toEqual({ activePhase: "hull", activePhasePassed: true, globalPassed: false });
    expect(workspaceGateOutcome(evaluation, "turret")).toEqual({ activePhase: "turret", activePhasePassed: false, globalPassed: false });
  });

  test("--global makes workspace gate exit on the complete evaluation", async () => {
    const { root, model } = await reviewReadyWorkspace();
    await writeFile(model, (await readFile(model, "utf8")).replace("MeshStandardMaterial", "MeshBasicMaterial"));
    const output: string[] = [];
    expect(await runCli(["gate", root, "--global"], { stdout: (value) => output.push(value), stderr: (value) => output.push(value) })).toBe(4);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ activePhase: "primary-mass", activePhasePassed: true, globalPassed: false });
  }, 30_000);
});

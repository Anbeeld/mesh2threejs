import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  bindOraclePreparation,
  createTaskState,
  loadTaskState,
  oraclePreparationIdentity,
  resumeWorkspace,
  runCli,
  saveTaskState,
  verifyWorkspaceOraclePreparation,
  type OracleManifest,
} from "../src/index.js";

function minimalGlb(options: { multipart?: boolean } = {}): Buffer {
  const positions = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1,
    -1, -1, -1, 1, 1, -1, -1, 1, -1,
  ]);
  const bin = Buffer.from(positions.buffer);
  const mesh = { primitives: [{ attributes: { POSITION: 0 } }], name: "body" };
  const nodes = options.multipart
    ? [{ mesh: 0, name: "hull" }, { mesh: 0, name: "turret", translation: [0, 2, 0] }]
    : [{ mesh: 0, name: "Object_0" }];
  const json = {
    asset: { version: "2.0", generator: "mesh2threejs-test" },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 6, type: "VEC3", min: [-1, -1, -1], max: [1, 1, -1] }],
    meshes: [mesh],
    nodes,
    scenes: [{ nodes: nodes.map((_, index) => index) }],
    scene: 0,
  };
  let jsonBytes = Buffer.from(JSON.stringify(json));
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binBytes = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const output = Buffer.alloc(total);
  output.write("glTF", 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(total, 8);
  output.writeUInt32LE(jsonBytes.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(output, 20);
  const binHeader = 20 + jsonBytes.length;
  output.writeUInt32LE(binBytes.length, binHeader);
  output.writeUInt32LE(0x004e4942, binHeader + 4);
  binBytes.copy(output, binHeader + 8);
  return output;
}

const sink = () => {
  const output: string[] = [];
  return { output, io: { stdout: (value: string) => output.push(value), stderr: (value: string) => output.push(value) } };
};

function onboardConfig(id: string, semanticMap: Record<string, string>): Record<string, unknown> {
  return {
    id, sourcePath: "ignored.glb", preparedPath: "ignored.json", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
    coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
    semanticMap, articulationMap: {}, normalization: { translation: [0, 1, 0], rotationEuler: [0, 0, 0], scale: 1 },
    authoritativeDimensions: null, dimensionSources: [],
  };
}

const registrationExpectation = { forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, requiredSemantics: ["primary"], requiredPivots: [], tolerance: 1e-6 };

const candidateSource = `import * as THREE from "three";\nexport function createCandidate(){ const root=new THREE.Group(); const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshStandardMaterial({color:new THREE.Color(0.5,0.5,0.5),roughness:0.7,metalness:0})); mesh.position.set(0,1,-1); mesh.name="primary"; mesh.userData.semanticId="primary"; root.add(mesh); return root; }\n`;

interface Fixture {
  parent: string;
  root: string;
  sourceA: string;
  sourceB: string;
}

async function prepareWorkspace(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-preparation-"));
  const root = join(parent, "workspace");
  const sourceA = join(parent, "first.glb");
  const sourceB = join(parent, "second.glb");
  await writeFile(sourceA, minimalGlb());
  await writeFile(sourceB, minimalGlb({ multipart: true }));
  expect(await runCli(["init", root, "--id", "preparation", "--goal", "fixture", "--profile", "generic", "--oracle", sourceA, "--ref", sourceB], sink().io)).toBe(0);
  return { parent, root, sourceA, sourceB };
}

async function onboardAndRegister(fixture: Fixture): Promise<void> {
  const config = join(fixture.parent, "onboard.json");
  await writeFile(config, JSON.stringify(onboardConfig("preparation", { "node:0": "primary" })));
  expect(await runCli(["onboard", fixture.root, "--config", config], sink().io)).toBe(0);
  const registration = join(fixture.parent, "registration.json");
  await writeFile(registration, JSON.stringify(registrationExpectation));
  expect(await runCli(["register", fixture.root, "--config", registration], sink().io)).toBe(0);
  expect(await runCli(["lock", fixture.root], sink().io)).toBe(0);
}

describe("live oracle preparation identity", () => {
  test("binds the admitted preparation in durable state and detects drift", async () => {
    const fixture = await prepareWorkspace();
    await onboardAndRegister(fixture);
    const manifest = JSON.parse(await readFile(join(fixture.root, ".mesh2threejs", "oracle", "manifest.json"), "utf8")) as OracleManifest;
    const state = await loadTaskState(join(fixture.root, ".mesh2threejs", "state.json"));
    expect(state.oraclePreparation).toEqual({
      identity: oraclePreparationIdentity(manifest),
      sourceHash: manifest.sourceHash,
      preparedHash: manifest.preparedHash,
    });
    expect((await verifyWorkspaceOraclePreparation(await resumeWorkspace(fixture.root))).binding.identity).toBe(state.oraclePreparation!.identity);

    state.oraclePreparation = { ...state.oraclePreparation!, identity: "stale-identity" };
    await saveTaskState(join(fixture.root, ".mesh2threejs", "state.json"), state);
    await expect(verifyWorkspaceOraclePreparation(await resumeWorkspace(fixture.root))).rejects.toThrow(/differs from the state-bound preparation/);
    const attempt = sink();
    expect(await runCli(["gate", fixture.root], attempt.io)).toBe(2);
    expect(attempt.output.join("\n")).toMatch(/differs from the state-bound preparation/);
  });

  test("switching the selected oracle archives the old preparation and only the re-onboarded oracle has authority", async () => {
    const fixture = await prepareWorkspace();
    await onboardAndRegister(fixture);
    await writeFile(join(fixture.root, "model", "model.mjs"), candidateSource);
    expect(await runCli(["gate", fixture.root, "--global"], sink().io)).toBe(0);
    const oldIdentity = (await loadTaskState(join(fixture.root, ".mesh2threejs", "state.json"))).oraclePreparation!.identity;

    const projectPath = join(fixture.root, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.oracle = "refs/oracle/second.glb";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    await expect(resumeWorkspace(fixture.root)).rejects.toThrow(/rebind/);
    expect(await runCli(["rebind", fixture.root], sink().io)).toBe(0);

    const oracleDirectory = join(fixture.root, ".mesh2threejs", "oracle");
    expect((await readdir(oracleDirectory)).filter((name) => name === "manifest.json" || name.startsWith("prepared"))).toEqual([]);
    const archived = (await readdir(join(oracleDirectory, "archive", "preparation-0001"))).sort();
    expect(archived).toEqual(["manifest.json", "prepared.json"]);

    const staleState = await loadTaskState(join(fixture.root, ".mesh2threejs", "state.json"));
    expect(staleState.oraclePreparation).toBeNull();
    expect(staleState.evidence).toEqual({});
    const gate = sink();
    expect(await runCli(["gate", fixture.root], gate.io)).toBe(2);
    expect(gate.output.join("\n")).toMatch(/no onboarded oracle preparation/);
    const registration = join(fixture.parent, "registration.json");
    const register = sink();
    expect(await runCli(["register", fixture.root, "--config", registration], register.io)).toBe(2);

    const config = join(fixture.parent, "onboard-b.json");
    await writeFile(config, JSON.stringify(onboardConfig("preparation-b", { "node:0": "primary", "node:1": "attachment" })));
    expect(await runCli(["onboard", fixture.root, "--config", config], sink().io)).toBe(0);
    const manifest = JSON.parse(await readFile(join(oracleDirectory, "manifest.json"), "utf8")) as OracleManifest;
    const state = await loadTaskState(join(fixture.root, ".mesh2threejs", "state.json"));
    expect(state.oraclePreparation).toEqual({
      identity: oraclePreparationIdentity(manifest),
      sourceHash: manifest.sourceHash,
      preparedHash: manifest.preparedHash,
    });
    expect(state.oraclePreparation!.identity).not.toBe(oldIdentity);
    expect(await runCli(["register", fixture.root, "--config", registration], sink().io)).toBe(0);
    expect(await runCli(["gate", fixture.root], sink().io)).toBe(4);
  }, 30_000);

  test("a stale preparation claiming another source fails as a source/preparation contradiction", async () => {
    const fixture = await prepareWorkspace();
    await onboardAndRegister(fixture);
    const projectPath = join(fixture.root, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf8"));
    project.oracle = "refs/oracle/second.glb";
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    expect(await runCli(["rebind", fixture.root], sink().io)).toBe(0);

    const oracleDirectory = join(fixture.root, ".mesh2threejs", "oracle");
    const archivedManifest = await readFile(join(oracleDirectory, "archive", "preparation-0001", "manifest.json"), "utf8");
    const archivedPrepared = await readFile(join(oracleDirectory, "archive", "preparation-0001", "prepared.json"), "utf8");
    await writeFile(join(oracleDirectory, "manifest.json"), archivedManifest);
    await writeFile(join(oracleDirectory, "prepared.json"), archivedPrepared);

    await expect(verifyWorkspaceOraclePreparation(await resumeWorkspace(fixture.root))).rejects.toThrow(/contradicts the selected oracle reference/);
    const attempt = sink();
    const registration = join(fixture.parent, "registration.json");
    await writeFile(registration, JSON.stringify(registrationExpectation));
    expect(await runCli(["register", fixture.root, "--config", registration], attempt.io)).toBe(2);
    expect(attempt.output.join("\n")).toMatch(/contradicts the selected oracle reference/);
    const repairConfig = join(fixture.parent, "repair-stale.json");
    await writeFile(repairConfig, JSON.stringify({ reason: "attempt to repair a stale preparation", preparedPath: "ignored.json" }));
    const repairAttempt = sink();
    expect(await runCli(["repair-oracle", fixture.root, "--config", repairConfig], repairAttempt.io)).toBe(2);
    expect(repairAttempt.output.join("\n")).toMatch(/contradicts the selected oracle reference/);
  });

  test("replacing the prepared bytes after a gate blocks the next authority action", async () => {
    const fixture = await prepareWorkspace();
    await onboardAndRegister(fixture);
    await writeFile(join(fixture.root, "model", "model.mjs"), candidateSource);
    expect(await runCli(["gate", fixture.root, "--global"], sink().io)).toBe(0);

    const preparedPath = join(fixture.root, ".mesh2threejs", "oracle", "prepared.json");
    const tampered = JSON.parse(await readFile(preparedPath, "utf8"));
    tampered.semanticMap = { "node:0": "attacker" };
    await writeFile(preparedPath, `${JSON.stringify(tampered, null, 2)}\n`);

    const gate = sink();
    expect(await runCli(["gate", fixture.root], gate.io)).toBe(2);
    expect(gate.output.join("\n")).toMatch(/lineage\/hash mismatch/);
    const render = sink();
    expect(await runCli(["render", fixture.root], render.io)).toBe(2);
    expect(render.output.join("\n")).toMatch(/lineage\/hash mismatch/);
  }, 30_000);

  test("repair destroys registration and downstream authority immediately and a rebuilt chain follows the new preparation", async () => {
    const fixture = await prepareWorkspace();
    await onboardAndRegister(fixture);
    await writeFile(join(fixture.root, "model", "model.mjs"), candidateSource);
    expect(await runCli(["gate", fixture.root, "--global"], sink().io)).toBe(0);
    expect(await runCli(["render", fixture.root], sink().io)).toBe(0);
    expect(await runCli(["prepare-review", fixture.root], sink().io)).toBe(0);
    const beforeRepair = await loadTaskState(join(fixture.root, ".mesh2threejs", "state.json"));

    const repair = join(fixture.parent, "repair.json");
    await writeFile(repair, JSON.stringify({ reason: "admit an explicit articulation pivot after inspection", preparedPath: "ignored.json", articulationMap: { primary: "primary-pivot" } }));
    expect(await runCli(["repair-oracle", fixture.root, "--config", repair], sink().io)).toBe(0);

    const manifest = JSON.parse(await readFile(join(fixture.root, ".mesh2threejs", "oracle", "manifest.json"), "utf8")) as OracleManifest;
    const state = await loadTaskState(join(fixture.root, ".mesh2threejs", "state.json"));
    expect(manifest.repairHistory).toHaveLength(1);
    expect(state.oraclePreparation).toEqual({
      identity: oraclePreparationIdentity(manifest),
      sourceHash: manifest.sourceHash,
      preparedHash: manifest.preparedHash,
    });
    expect(state.oraclePreparation!.identity).not.toBe(beforeRepair.oraclePreparation!.identity);
    expect(state.oracleHash).toBeNull();
    expect(state.locks).toEqual({});
    expect(state.evaluationIdentityHash).toBeNull();
    expect(state.phaseGeometryHashes).toEqual({});
    expect(state.activePhase).toBe("oracle-registration");
    expect(state.visualReviewStatus).toBe("awaiting");
    expect(Object.values(state.evidence).every((evidence) => !evidence.valid)).toBe(true);

    const staleReview = sink();
    expect(await runCli(["prepare-review", fixture.root], staleReview.io)).toBe(2);
    expect(staleReview.output.join("\n")).toMatch(/stale/i);
    const finalization = sink();
    expect(await runCli(["finalize", fixture.root], finalization.io)).toBe(2);
    expect(finalization.output.join("\n")).toMatch(/oracle and candidate hashes|unlocked phases/i);

    const registration = join(fixture.parent, "registration.json");
    await writeFile(registration, JSON.stringify(registrationExpectation));
    expect(await runCli(["register", fixture.root, "--config", registration], sink().io)).toBe(0);
    expect(await runCli(["lock", fixture.root], sink().io)).toBe(0);
    expect(await runCli(["gate", fixture.root, "--global"], sink().io)).toBe(0);
  }, 60_000);

  test("bindOraclePreparation invalidates the complete downstream chain exactly once", async () => {
    const phases = ["oracle-registration", "primary-mass", "attachments", "identity-features", "style-complexity", "visual-review", "final"];
    const first = bindOraclePreparation(createTaskState({ taskId: "binding", profile: "generic", style: "low-poly-faithful" }), { identity: "prep-a", sourceHash: "source-a", preparedHash: "prepared-a" }, "onboard A");
    expect(first.oraclePreparation).toEqual({ identity: "prep-a", sourceHash: "source-a", preparedHash: "prepared-a" });

    const second = bindOraclePreparation({ ...first, oracleHash: "oracle-fingerprint", locks: { "oracle-registration": { phase: "oracle-registration", geometryHash: "hash", evidence: [], oracleHash: "oracle-fingerprint", candidateHash: "unbound", contractHash: "contract", acceptedAt: "now" } }, phaseStatus: { ...first.phaseStatus, "primary-mass": "active" }, evaluationIdentityHash: "identity-hash" }, { identity: "prep-b", sourceHash: "source-a", preparedHash: "prepared-b" }, "repair to preparation B");
    expect(second.oraclePreparation).toEqual({ identity: "prep-b", sourceHash: "source-a", preparedHash: "prepared-b" });
    expect(second.oracleHash).toBeNull();
    expect(second.locks).toEqual({});
    expect(second.evaluationIdentityHash).toBeNull();
    expect(second.activePhase).toBe("oracle-registration");
    expect(Object.keys(second.phaseStatus).sort()).toEqual([...phases].sort());
    expect(second.phaseStatus).toMatchObject({ "oracle-registration": "active", "primary-mass": "pending" });
    expect(second.systemDecisions.at(-1)).toMatchObject({ value: "prep-b", reason: "repair to preparation B" });

    expect(bindOraclePreparation(second, { identity: "prep-b", sourceHash: "source-a", preparedHash: "prepared-b" }, "repeat")).toBe(second);
  });
});

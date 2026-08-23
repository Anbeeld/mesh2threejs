import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as THREE from "three";
import { loadPreparedOracle, onboardOracle, probeGlb, repairPreparedOracle, runCli, validateOracleManifest, verifyOracleRegistration } from "../src/index.js";

function minimalGlb(options: { multipart?: boolean; translated?: boolean; sceneOffset?: [number, number, number] } = {}): Buffer {
  const positions = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1,
    -1, -1, -1, 1, 1, -1, -1, 1, -1,
  ]);
  const bin = Buffer.from(positions.buffer);
  const mesh = { primitives: [{ attributes: { POSITION: 0 } }], name: "body" };
  const offset = options.sceneOffset ?? [0, 0, 0];
  const nodes = options.multipart
    ? [{ mesh: 0, name: "hull", translation: offset }, { mesh: 0, name: "turret", translation: [offset[0], offset[1] + 2, offset[2]] }]
    : [{ mesh: 0, name: "Object_0", ...(options.translated ? { translation: [3, 0, 0] } : {}) }];
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

describe("source and prepared oracle lifecycle", () => {
  test("runs onboarding, gates, and renders from only a workspace root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-workspace-cli-"));
    const root = join(parent, "workspace");
    const source = join(parent, "source.glb");
    await writeFile(source, minimalGlb());
    const sink = { stdout: () => undefined, stderr: () => undefined };
    expect(await runCli(["init", root, "--id", "root-cli", "--goal", "reconstruct", "--profile", "generic", "--oracle", source], sink)).toBe(0);
    const config = join(parent, "onboard.json");
    await writeFile(config, JSON.stringify({
      id: "root-cli", sourcePath: "ignored.glb", preparedPath: "ignored.json", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
      coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
      semanticMap: { "node:0": "primary" }, articulationMap: {}, normalization: { translation: [0, 1, 0], rotationEuler: [0, 0, 0], scale: 1 },
      authoritativeDimensions: null, dimensionSources: [],
    }));
    expect(await runCli(["onboard", root, "--config", config], sink)).toBe(0);
    const manifest = JSON.parse(await readFile(join(root, ".mesh2threejs", "oracle", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ sourcePath: "refs/oracle/source.glb", preparedPath: ".mesh2threejs/oracle/prepared.json", portable: true });
    const repair = join(parent, "repair.json");
    await writeFile(repair, JSON.stringify({ reason: "confirm explicit semantic mapping", preparedPath: "ignored.json" }));
    expect(await runCli(["repair-oracle", root, "--config", repair], sink)).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mesh2threejs", "oracle", "manifest.json"), "utf8")).preparedPath).toBe(".mesh2threejs/oracle/prepared-repair-1.json");
    const registration = join(parent, "registration.json");
    await writeFile(registration, JSON.stringify({ forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, requiredSemantics: ["primary"], requiredPivots: [], tolerance: 1e-6 }));
    expect(await runCli(["register", root, "--config", registration], sink)).toBe(0);
    expect(await runCli(["lock", root], sink)).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mesh2threejs", "reports", "registration-0001.json"), "utf8")).passed).toBe(true);
    await writeFile(join(root, "model", "model.mjs"), `import * as THREE from "three";\nexport function createCandidate(){ const root=new THREE.Group(); const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshStandardMaterial({color:new THREE.Color(0.5,0.5,0.5),roughness:0.7,metalness:0})); mesh.position.set(0,1,-1); mesh.name="primary"; mesh.userData.semanticId="primary"; root.add(mesh); return root; }\n`);
    expect(await runCli(["gate", root, "--global"], sink)).toBe(0);
    expect(await readFile(join(root, ".mesh2threejs", "reports", "gate-0001.json"), "utf8")).toContain("oracleHash");
    await writeFile(join(root, ".mesh2threejs", "captures", "render-manifest.json"), "stale output\n");
    expect(await runCli(["render", root], sink)).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mesh2threejs", "captures", "render-0001", "render-manifest.json"), "utf8"))).toMatchObject({ schemaVersion: 1 });
    expect(await runCli(["prepare-review", root], sink)).toBe(0);
    expect(await runCli(["review-status", root], sink)).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mesh2threejs", "visual-review", "review-0001", "packet.json"), "utf8"))).toMatchObject({ schemaVersion: 4 });
    const firstGateArtifact = await readFile(join(root, ".mesh2threejs", "evidence", "gate-0001", "gate-0001-primary-mass.json"), "utf8");
    expect(await runCli(["gate", root, "--global"], sink)).toBe(0);
    expect(await readFile(join(root, ".mesh2threejs", "evidence", "gate-0001", "gate-0001-primary-mass.json"), "utf8")).toBe(firstGateArtifact);
    expect((await readdir(join(root, ".mesh2threejs", "evidence"))).filter((name) => name.startsWith("gate-"))).toEqual(["gate-0001", "gate-0002"]);
  }, 60_000);

  test("probes GLB inventory, bounds, provenance, and conservative semantics", () => {
    const fused = probeGlb(minimalGlb());
    const multipart = probeGlb(minimalGlb({ multipart: true }));
    expect(fused.scene.meshCount).toBe(1);
    expect(fused.bounds?.size).toEqual([2, 2, 0]);
    expect(probeGlb(minimalGlb({ translated: true })).bounds?.center[0]).toBe(3);
    expect(fused.semanticReadiness).toBe("insufficient");
    expect(multipart.semanticReadiness).toBe("partial");
    expect(fused.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("probe suggestions are invariant under whole-scene translation", () => {
    const centered = probeGlb(minimalGlb({ multipart: true, sceneOffset: [0, 0, 0] }));
    const positive = probeGlb(minimalGlb({ multipart: true, sceneOffset: [50, 0, 0] }));
    const negative = probeGlb(minimalGlb({ multipart: true, sceneOffset: [-50, 0, 0] }));
    for (const probe of [centered, positive, negative]) {
      expect(probe.scene.nodeCount).toBe(2);
      expect(probe.scene.meshCount).toBe(1);
      expect(probe.semanticReadiness).toBe("partial");
    }
    // Ranking/confidence/kind must not depend on where the model sits in world space.
    expect(positive.suggestions).toEqual(centered.suggestions);
    expect(negative.suggestions).toEqual(centered.suggestions);
    expect(centered.bounds?.center[0]).toBe(0);
    expect(positive.bounds?.center[0]).toBe(50);
    expect(negative.bounds?.center[0]).toBe(-50);
    expect(positive.bounds?.size).toEqual(centered.bounds?.size);
    expect(negative.bounds?.size).toEqual(centered.bounds?.size);
  });

  test("rejects malformed GLB rather than guessing", () => {
    expect(() => probeGlb(Buffer.from("not glb"))).toThrow(/GLB/);
  });

  test("records immutable lineage and applies a reproducible preparation recipe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh2threejs-oracle-"));
    const source = join(directory, "source.glb");
    const prepared = join(directory, "prepared.json");
    await writeFile(source, minimalGlb({ translated: true }));
    const manifest = await onboardOracle({
      id: "fixture",
      sourcePath: source,
      preparedPath: prepared,
      source: "self-authored analytical fixture",
      author: "mesh2threejs",
      license: "MIT",
      redistribution: "allowed",
      coordinateFrame: "right-handed",
      upAxis: "+y",
      forwardAxis: "+z",
      grounding: "min-y=0",
      scale: 2,
      semanticMap: { "node:0": "primary" },
      articulationMap: {},
      normalization: { translation: [-3, 1, 0], rotationEuler: [0, 0, 0], scale: 2 },
      authoritativeDimensions: null,
      dimensionSources: [],
    });
    expect(manifest.sourceHash).not.toBe(manifest.preparedHash);
    expect(JSON.parse(await readFile(prepared, "utf8")).parentSourceHash).toBe(manifest.sourceHash);
    const scene = await loadPreparedOracle(manifest);
    const mesh = scene.getObjectByName("Object_0");
    expect(mesh?.userData.semanticId).toBe("primary");
    expect(mesh?.getWorldPosition(new THREE.Vector3()).x).toBeCloseTo(0);

    const registration = verifyOracleRegistration(scene, {
      forwardAxis: "+z",
      upAxis: "+y",
      expectedScale: 2,
      groundY: 0,
      requiredSemantics: ["primary"],
      requiredPivots: [],
      tolerance: 1e-6,
    });
    expect(registration.passed).toBe(true);

    const repairedPath = join(directory, "prepared-repaired.json");
    const repaired = await repairPreparedOracle(manifest, {
      reason: "admit an articulation pivot after inspection",
      preparedPath: repairedPath,
      articulationMap: { primary: "primary-pivot" },
    });
    expect(repaired.sourceHash).toBe(manifest.sourceHash);
    expect(repaired.preparedHash).not.toBe(manifest.preparedHash);
    expect(repaired.repairHistory).toHaveLength(1);
    expect(JSON.parse(await readFile(repairedPath, "utf8")).parentSourceHash).toBe(manifest.sourceHash);
    const repairedScene = await loadPreparedOracle(repaired);
    expect(repairedScene.getObjectByName("Object_0")?.userData.articulationPivot).toBe("primary-pivot");
    const repairedRegistration = verifyOracleRegistration(repairedScene, {
      forwardAxis: "+z", upAxis: "+y", expectedScale: 2, groundY: 0,
      requiredSemantics: ["primary"], requiredPivots: ["primary-pivot"], tolerance: 1e-6,
    });
    expect(repairedRegistration.rows.filter((row) => !row.passed)).toEqual([]);
  });

  test("persists workspace-relative oracle lineage that survives relocation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-oracle-portable-"));
    const root = join(parent, "original");
    await mkdir(join(root, "refs", "oracle"), { recursive: true });
    await writeFile(join(root, "refs", "oracle", "source.glb"), minimalGlb({ multipart: true }));
    const manifest = await onboardOracle({
      id: "portable",
      workspaceRoot: root,
      referenceMode: "copy",
      sourceOriginalPath: "D:\\incoming\\source.glb",
      sourcePath: "refs/oracle/source.glb",
      preparedPath: ".mesh2threejs/oracle/prepared.json",
      source: "fixture",
      author: "fixture",
      license: "MIT",
      redistribution: "allowed",
      coordinateFrame: "right-handed",
      upAxis: "+y",
      forwardAxis: "+z",
      grounding: "min-y=0",
      scale: 1,
      semanticMap: { "node:0": "primary", "node:1": "attachment" },
      articulationMap: {},
      normalization: { translation: [0, 1, 0], rotationEuler: [0, 0, 0], scale: 1 },
      authoritativeDimensions: null,
      dimensionSources: [],
    });
    expect(manifest).toMatchObject({
      sourcePath: "refs/oracle/source.glb",
      preparedPath: ".mesh2threejs/oracle/prepared.json",
      sourceOriginalPath: "D:\\incoming\\source.glb",
      referenceMode: "copy",
      portable: true,
    });
    expect(validateOracleManifest(manifest).valid).toBe(true);
    expect(JSON.parse(await readFile(join(root, manifest.preparedPath), "utf8")).sourcePath).toBe("refs/oracle/source.glb");
    expect((await loadPreparedOracle(manifest, root)).getObjectByName("hull")).toBeDefined();

    const relocated = join(parent, "relocated");
    await cp(root, relocated, { recursive: true });
    expect((await loadPreparedOracle(manifest, relocated)).getObjectByName("turret")).toBeDefined();
  });
});

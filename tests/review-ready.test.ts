import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli, viewerStatus } from "../src/index.js";

function minimalGlb(): Buffer {
  const positions = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1,
    -1, -1, -1, 1, 1, -1, -1, 1, -1,
  ]);
  const bin = Buffer.from(positions.buffer);
  const json = {
    asset: { version: "2.0", generator: "mesh2threejs-test" },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 6, type: "VEC3", min: [-1, -1, -1], max: [1, 1, -1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }], name: "body" }],
    nodes: [{ mesh: 0, name: "body" }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  let jsonBytes = Buffer.from(JSON.stringify(json));
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binBytes = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const output = Buffer.alloc(12 + 8 + jsonBytes.length + 8 + binBytes.length);
  output.write("glTF", 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonBytes.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(output, 20);
  const binHeader = 20 + jsonBytes.length;
  output.writeUInt32LE(binBytes.length, binHeader);
  output.writeUInt32LE(0x004e4942, binHeader + 4);
  binBytes.copy(output, binHeader + 8);
  return output;
}

const MODEL_A = 'import * as THREE from "three";\nexport function createCandidate(){ const root=new THREE.Group(); const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshStandardMaterial({color:new THREE.Color(0.5,0.5,0.5),roughness:0.7,metalness:0})); mesh.position.set(0,1,-1); mesh.name="primary"; mesh.userData.semanticId="primary"; root.add(mesh); return root; }\n';
const MODEL_B = 'import * as THREE from "three";\nexport function createCandidate(){ const root=new THREE.Group(); const mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshStandardMaterial({color:new THREE.Color(0.4,0.5,0.6),roughness:0.6,metalness:0})); mesh.position.set(0,1,-1); mesh.name="primary"; mesh.userData.semanticId="primary"; root.add(mesh); return root; }\n';

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

describe("user-review handoff capture", () => {
  test("refreshes a full capture for the live gated candidate without starting the viewer", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-review-ready-"));
    const root = join(parent, "workspace");
    const source = join(parent, "source.glb");
    await writeFile(source, minimalGlb());
    const output: string[] = [];
    const sink = { stdout: (value: string) => { output.push(value); }, stderr: (value: string) => { output.push(`ERR:${value}`); } };
    const lastJson = (): Record<string, unknown> => JSON.parse(output[output.length - 1]!) as Record<string, unknown>;

    expect(await runCli(["init", root, "--id", "review-ready", "--goal", "reconstruct", "--profile", "generic", "--oracle", source], sink)).toBe(0);
    const onboard = join(parent, "onboard.json");
    await writeFile(onboard, JSON.stringify({
      id: "review-ready", sourcePath: "ignored.glb", preparedPath: "ignored.json", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
      coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
      semanticMap: { "node:0": "primary" }, articulationMap: {}, normalization: { translation: [0, 1, 0], rotationEuler: [0, 0, 0], scale: 1 },
      authoritativeDimensions: null, dimensionSources: [],
    }));
    expect(await runCli(["onboard", root, "--config", onboard], sink)).toBe(0);
    const registration = join(parent, "registration.json");
    await writeFile(registration, JSON.stringify({ forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, requiredSemantics: ["primary"], requiredPivots: [], tolerance: 1e-6 }));
    expect(await runCli(["register", root, "--config", registration], sink)).toBe(0);
    expect(await runCli(["lock", root], sink)).toBe(0);
    await writeFile(join(root, "model", "model.mjs"), MODEL_A);
    expect(await runCli(["gate", root], sink)).toBe(0);
    expect(await runCli(["render", root], sink)).toBe(0);

    const firstHandoff = lastJson();
    expect(await runCli(["review-ready", root], sink)).toBe(0);
    void firstHandoff;
    const handoffA = lastJson() as { status: string; candidateHash: string; capture: { run: string; directory: string; manifest: string; boards: string[]; turntable: string }; viewer: { status: string } };
    expect(handoffA.status).toBe("ready-for-user-review");
    expect(handoffA.capture.run).toBe("render-0002");
    expect(handoffA.capture.boards).toHaveLength(3);
    expect(await exists(resolve(root, handoffA.capture.manifest))).toBe(true);
    for (const board of handoffA.capture.boards) expect(await exists(resolve(root, board))).toBe(true);
    expect(await exists(resolve(root, handoffA.capture.turntable))).toBe(true);
    const manifestA = JSON.parse(await readFile(resolve(root, handoffA.capture.manifest), "utf8")) as { candidateHash: string };
    expect(manifestA.candidateHash).toBe(handoffA.candidateHash);
    expect(handoffA.viewer.status).toBe("not-running");

    // Change the candidate, re-gate, and hand off again: a brand-new run must appear.
    await writeFile(join(root, "model", "model.mjs"), MODEL_B);
    expect(await runCli(["gate", root], sink)).toBe(0);
    expect(await runCli(["review-ready", root], sink)).toBe(0);
    const handoffB = lastJson() as typeof handoffA;
    expect(handoffB.capture.run).toBe("render-0003");
    expect(handoffB.candidateHash).not.toBe(handoffA.candidateHash);
    const manifestB = JSON.parse(await readFile(resolve(root, handoffB.capture.manifest), "utf8")) as { candidateHash: string };
    expect(manifestB.candidateHash).toBe(handoffB.candidateHash);
    const runs = (await readdir(join(root, ".mesh2threejs", "captures"))).filter((name) => name.startsWith("render-"));
    expect(runs).toEqual(["render-0001", "render-0002", "render-0003"]);

    // The handoff never launches the viewer: no runtime metadata, no live server.
    expect(await exists(join(root, ".mesh2threejs", "viewer", "server.json"))).toBe(false);
    expect(await viewerStatus(root)).toEqual({ status: "not-running" });
  }, 120_000);
});

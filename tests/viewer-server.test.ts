import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createViewerServer, initializeWorkspace, type ViewerServerHandle } from "../src/index.js";

const handles: ViewerServerHandle[] = [];

afterEach(async () => {
  while (handles.length) await handles.pop()!.close();
});

async function makeWorkspace(profile: "generic" | "tank" = "generic"): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), "mesh2threejs-viewer-ws-")), "workspace");
  await initializeWorkspace(root, { id: "viewer-fixture", goal: "inspect the candidate", profile });
  return root;
}

async function startServer(root: string): Promise<ViewerServerHandle> {
  const handle = await createViewerServer({ workspaceRoot: root, port: 0, shutdownToken: "token-test", instanceId: "instance-test" });
  handles.push(handle);
  return handle;
}

async function get(handle: ViewerServerHandle, path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(new URL(path, handle.url));
  return { status: response.status, body: await response.text() };
}

describe("viewer HTTP serving boundary", () => {
  test("serves the viewer app and audited candidate on loopback only", async () => {
    const root = await makeWorkspace();
    const handle = await startServer(root);
    expect(handle.host).toBe("127.0.0.1");
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
    expect((await get(handle, "/")).status).toBe(200);
    expect((await get(handle, "/assets/viewer.js")).status).toBe(200);
    const candidate = await get(handle, "/candidate/model.mjs");
    expect(candidate.status).toBe(200);
    expect(candidate.body).toContain("createCandidate");
    const vendor = await get(handle, "/vendor/three/three.module.js");
    expect(vendor.status).toBe(200);
    expect(vendor.body).toContain("WebGLRenderer");
    expect((await get(handle, "/vendor/three/examples/jsm/controls/OrbitControls.js")).status).toBe(200);
  });

  test("denies oracle assets, internal state, and arbitrary workspace files", async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, "refs", "oracle"), { recursive: true });
    await writeFile(join(root, "refs", "oracle", "source.glb"), "oracle-bytes");
    const handle = await startServer(root);
    for (const path of [
      "/refs/oracle/source.glb",
      "/.mesh2threejs/state.json",
      "/project.json",
      "/candidate/../project.json",
      "/candidate/%2e%2e/project.json",
      "/candidate/%2e%2e/%2e%2e/package.json",
      "/candidate/../../refs/oracle/source.glb",
      "/api/../project.json",
    ]) {
      const response = await fetch(new URL(path, handle.url));
      expect([403, 404, 409]).toContain(response.status);
      expect(await response.text()).not.toContain("schemaVersion");
    }
  });

  test("serves a transitive dependency if and only if it belongs to the audited graph", async () => {
    const root = await makeWorkspace();
    await writeFile(join(root, "model", "helper.mjs"), "export const factor = 2;\n");
    await writeFile(join(root, "model", "model.mjs"), 'import * as THREE from "three";\nimport { factor } from "./helper.mjs";\nexport function createCandidate(){ const g = new THREE.Group(); g.userData.factor = factor; return g; }\n');
    await writeFile(join(root, "model", "not-imported.mjs"), "export const secret = 1;\n");
    const handle = await startServer(root);
    expect((await get(handle, "/candidate/model.mjs")).status).toBe(200);
    expect((await get(handle, "/candidate/helper.mjs")).status).toBe(200);
    expect((await get(handle, "/candidate/not-imported.mjs")).status).toBe(404);
  });

  test("keeps the server alive across invalid candidate edits and recovers", async () => {
    const root = await makeWorkspace();
    const handle = await startServer(root);
    const valid = JSON.parse((await get(handle, "/api/version")).body) as { status: string; sourceHash?: string };
    expect(valid.status).toBe("ok");
    await writeFile(join(root, "model", "model.mjs"), 'import { x } from "./missing-helper.mjs";\nexport function createCandidate(){ return x; }\n');
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    const broken = JSON.parse((await get(handle, "/api/version")).body) as { status: string; error?: string };
    expect(broken.status).toBe("invalid");
    expect((await get(handle, "/health")).status).toBe(200);
    await writeFile(join(root, "model", "model.mjs"), 'import * as THREE from "three";\nexport function createCandidate(){ const g = new THREE.Group(); g.name = "recovered"; return g; }\n');
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    const recovered = JSON.parse((await get(handle, "/api/version")).body) as { status: string; sourceHash?: string };
    expect(recovered.status).toBe("ok");
    expect(recovered.sourceHash).not.toBe(valid.sourceHash);
    expect((await get(handle, "/candidate/model.mjs")).body).toContain("recovered");
  });

  test("exposes profile and subject articulation controls, or none", async () => {
    const tank = await makeWorkspace("tank");
    const tankHandle = await startServer(tank);
    const tankModel = JSON.parse((await get(tankHandle, "/api/model")).body) as { status: string; articulation: Array<{ control: string; samples: number[] }> };
    expect(tankModel.status).toBe("ok");
    expect(tankModel.articulation.map((control) => control.control)).toEqual(["turretYaw", "gunElevation"]);

    const generic = join(await mkdtemp(join(tmpdir(), "mesh2threejs-viewer-contract-")), "workspace");
    await mkdir(join(generic, "refs", "docs"), { recursive: true });
    const contractPath = join(generic, "refs", "docs", "subject.json");
    await writeFile(contractPath, JSON.stringify({ articulation: [{ control: "jaw", moving: ["jaw"], stationary: ["body"], samples: [-0.4, 0, 0.4] }] }));
    await initializeWorkspace(generic, { id: "viewer-contracts", goal: "inspect controls", profile: "generic", subjectContract: contractPath });
    const genericHandle = await startServer(generic);
    const genericModel = JSON.parse((await get(genericHandle, "/api/model")).body) as { status: string; articulation: Array<{ control: string; min: number; max: number; neutral: number }> };
    expect(genericModel.articulation).toEqual([{ control: "jaw", samples: [-0.4, 0, 0.4], min: -0.4, max: 0.4, neutral: 0 }]);

    const plain = await makeWorkspace("generic");
    const plainHandle = await startServer(plain);
    const plainModel = JSON.parse((await get(plainHandle, "/api/model")).body) as { articulation: unknown[] };
    expect(plainModel.articulation).toEqual([]);
  });

  test("protects shutdown with the instance token and never serves state-changing endpoints", async () => {
    const root = await makeWorkspace();
    const handle = await startServer(root);
    const wrong = await fetch(new URL("/shutdown", handle.url), { method: "POST", headers: { "x-mesh2threejs-shutdown-token": "wrong" } });
    expect(wrong.status).toBe(403);
    const getShutdown = await fetch(new URL("/shutdown", handle.url), { method: "GET" });
    expect(getShutdown.status).toBe(404);
    expect((await fetch(new URL("/eval", handle.url), { method: "POST" })).status).toBe(404);
    expect((await get(handle, "/health")).status).toBe(200);
    const right = await fetch(new URL("/shutdown", handle.url), { method: "POST", headers: { "x-mesh2threejs-shutdown-token": "token-test" } });
    expect(right.status).toBe(202);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    await expect(get(handle, "/health")).rejects.toThrow();
  });
});

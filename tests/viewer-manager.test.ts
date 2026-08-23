import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, expect, test } from "vitest";
import { initializeWorkspace, startViewer, stopViewer, viewerStatus, viewerRuntimeDirectory } from "../src/index.js";

async function makeWorkspace(): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), "mesh2threejs-viewer-mgr-")), "workspace");
  await initializeWorkspace(root, { id: "viewer-manager-fixture", goal: "inspect the candidate", profile: "generic" });
  return root;
}

describe("persistent viewer process management", () => {
  test("starts a detached loopback viewer, is idempotent, and stops the recorded instance", async () => {
    const root = await makeWorkspace();
    const started = await startViewer(root, { port: "auto" });
    expect(started.status).toBe("started");
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
    try {
      const health = await (await fetch(new URL("health", started.url))).json() as { status: string };
      expect(health.status).toBe("ok");
      const index = await fetch(started.url);
      expect(index.status).toBe(200);
      const status = await viewerStatus(root);
      expect(status).toMatchObject({ status: "running", record: { pid: started.pid } });
      const again = await startViewer(root, { port: "auto" });
      expect(again.status).toBe("already-running");
      expect(again.url).toBe(started.url);
      expect(again.pid).toBe(started.pid);
    } finally {
      expect(await stopViewer(root)).toEqual({ status: "stopped" });
    }
    expect(await viewerStatus(root)).toEqual({ status: "not-running" });
    await expect(readFile(join(viewerRuntimeDirectory(root), "server.json"), "utf8")).rejects.toThrow();
    await expect(fetch(started.url)).rejects.toThrow();
  }, 60_000);

  test("recovers stale runtime metadata without targeting an arbitrary process", async () => {
    const root = await makeWorkspace();
    await mkdir(viewerRuntimeDirectory(root), { recursive: true });
    await writeFile(join(viewerRuntimeDirectory(root), "server.json"), JSON.stringify({
      schemaVersion: 1,
      pid: 999_999_999,
      host: "127.0.0.1",
      port: 1,
      url: "http://127.0.0.1:1/",
      startedAt: new Date().toISOString(),
      workspace: root,
      instanceId: "dead",
      shutdownToken: "dead",
    }));
    expect(await viewerStatus(root)).toMatchObject({ status: "stale-record" });
    expect(await stopViewer(root)).toEqual({ status: "stale-record-cleared" });
    const started = await startViewer(root, { port: "auto" });
    expect(started.status).toBe("started");
    await stopViewer(root);
  }, 60_000);

  test("fails clearly when an explicitly requested port is occupied", async () => {
    const root = await makeWorkspace();
    const blocker = createServer();
    await new Promise<void>((resolveListen) => blocker.listen(0, "127.0.0.1", () => resolveListen()));
    const address = blocker.address();
    const occupied = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(startViewer(root, { port: occupied })).rejects.toThrow(/already in use/iu);
      expect(await viewerStatus(root)).toEqual({ status: "not-running" });
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()));
    }
  }, 60_000);

  test("honors an explicit free port and reports status through the CLI-shaped result", async () => {
    const root = await makeWorkspace();
    const probe = createServer();
    await new Promise<void>((resolveListen) => probe.listen(0, "127.0.0.1", () => resolveListen()));
    const address = probe.address();
    const freePort = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
    const started = await startViewer(root, { port: freePort });
    expect(started).toMatchObject({ status: "started", host: "127.0.0.1", port: freePort, url: `http://127.0.0.1:${freePort}/` });
    await stopViewer(root);
  }, 60_000);
});

#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createViewerServer } from "./server.js";
import { viewerRuntimeDirectory, type ViewerRuntimeRecord } from "./manager.js";

/**
 * Detached viewer server entry. Spawned by `viewer start`; writes its runtime record once
 * listening and removes it on clean exit. Its stdio is deliberately detached from the launcher,
 * so diagnoses self-log to the runtime directory instead. Not part of the public API surface.
 */

let logPath: string | undefined;
function logLine(message: string): void {
  if (!logPath) return;
  try { appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`); } catch { /* logging is best-effort */ }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [workspace, portArgument, shutdownToken, instanceId] = argv;
  if (!workspace || !portArgument || !shutdownToken || !instanceId) throw new Error("usage: server-main <workspace> <port> <shutdownToken> <instanceId> [--trusted-scene path --trusted-scene-sha256 hash]");
  const port = Number(portArgument);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid viewer port: ${portArgument}`);
  const workspaceRoot = resolve(workspace);
  const runtime = viewerRuntimeDirectory(workspaceRoot);
  await mkdir(runtime, { recursive: true });
  logPath = join(runtime, "server.log");
  const recordPath = join(runtime, "server.json");
  let trustedScene: { path: string; sha256: string } | undefined;
  const sceneFlag = argv.indexOf("--trusted-scene");
  const sceneHashFlag = argv.indexOf("--trusted-scene-sha256");
  if (sceneFlag >= 0 && sceneHashFlag >= 0 && argv[sceneFlag + 1] && argv[sceneHashFlag + 1]) {
    trustedScene = { path: resolve(argv[sceneFlag + 1]!), sha256: argv[sceneHashFlag + 1]! };
  }
  const handle = await createViewerServer({ workspaceRoot, port, shutdownToken, instanceId, ...(trustedScene ? { trustedScene } : {}) });
  const record: ViewerRuntimeRecord = {
    schemaVersion: 1,
    pid: process.pid,
    host: handle.host,
    port: handle.port,
    url: handle.url,
    startedAt: new Date().toISOString(),
    workspace: workspaceRoot,
    instanceId,
    shutdownToken,
  };
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const shutdown = async (): Promise<void> => {
    await rm(recordPath, { force: true });
    logLine(`viewer stopped pid=${process.pid}`);
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
  handle.server.on("close", () => { void shutdown(); });
  logLine(`mesh2threejs viewer listening at ${handle.url} pid=${process.pid}`);
}

main().catch((error) => {
  logLine(`viewer failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});

import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { VIEWER_DEFAULT_PORT, viewerPackageRoot } from "./server.js";

export interface ViewerRuntimeRecord {
  schemaVersion: 1;
  pid: number;
  host: string;
  port: number;
  url: string;
  startedAt: string;
  workspace: string;
  instanceId: string;
  shutdownToken: string;
}

export type ViewerStatusResult =
  | { status: "not-running" }
  | { status: "running"; record: ViewerRuntimeRecord }
  | { status: "stale-record"; record: ViewerRuntimeRecord | null };

export interface ViewerStartOptions {
  /** Explicit port, "auto" for any free loopback port, or omitted to prefer the default port. */
  port?: number | "auto";
  /** Test hook replacing the platform launcher. Receives the daemon argv including the entry. */
  spawnServer?: (daemonArguments: string[]) => void;
  readyTimeoutMs?: number;
}

export type ViewerStartResult =
  | { status: "started"; url: string; host: string; port: number; pid: number; record: ViewerRuntimeRecord }
  | { status: "already-running"; url: string; host: string; port: number; pid: number; record: ViewerRuntimeRecord };

export type ViewerStopResult =
  | { status: "stopped" }
  | { status: "not-running" }
  | { status: "stale-record-cleared" };

export function viewerRuntimeDirectory(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), ".mesh2threejs", "viewer");
}

function viewerRecordPath(workspaceRoot: string): string {
  return join(viewerRuntimeDirectory(workspaceRoot), "server.json");
}

async function readRuntimeRecord(workspaceRoot: string): Promise<ViewerRuntimeRecord | null> {
  try {
    const value = JSON.parse(await readFile(viewerRecordPath(workspaceRoot), "utf8")) as ViewerRuntimeRecord;
    return value && value.schemaVersion === 1 && typeof value.url === "string" ? value : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Probes the live server and confirms it is the recorded instance for this exact workspace. */
export async function probeViewerHealth(record: ViewerRuntimeRecord, workspaceRoot: string, timeoutMs = 1500): Promise<boolean> {
  const response = await fetchWithTimeout(`${record.url}health`, { method: "GET" }, timeoutMs);
  if (!response?.ok) return false;
  try {
    const body = await response.json() as { status?: string; instanceId?: string; workspace?: string };
    return body.status === "ok" && body.instanceId === record.instanceId && resolve(body.workspace ?? "") === resolve(workspaceRoot);
  } catch {
    return false;
  }
}

export async function viewerStatus(workspaceRoot: string): Promise<ViewerStatusResult> {
  const record = await readRuntimeRecord(workspaceRoot);
  if (!record) return { status: "not-running" };
  if (await probeViewerHealth(record, workspaceRoot)) return { status: "running", record };
  return { status: "stale-record", record };
}

async function assertPortFree(port: number): Promise<void> {
  const probe = createServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      probe.once("error", rejectListen);
      probe.listen(port, "127.0.0.1", () => resolveListen());
    });
  } catch {
    throw new Error(`requested viewer port ${port} is already in use`);
  } finally {
    await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  }
}

async function selectPort(option: number | "auto" | undefined): Promise<number> {
  if (typeof option === "number") {
    if (!Number.isInteger(option) || option < 1 || option > 65535) throw new Error(`invalid viewer port: ${option}`);
    await assertPortFree(option);
    return option;
  }
  if (option !== "auto") {
    try {
      await assertPortFree(VIEWER_DEFAULT_PORT);
      return VIEWER_DEFAULT_PORT;
    } catch { /* fall through to any free loopback port */ }
  }
  const probe = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once("error", rejectListen);
    probe.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  if (!port) throw new Error("no free loopback port is available for the viewer");
  return port;
}

function viewerServerEntryArguments(): string[] {
  // The built package ships plain .js; under TypeScript sources (vitest) spawn the .ts entry via tsx.
  const jsEntry = fileURLToPath(new URL("./server-main.js", import.meta.url));
  if (existsSync(jsEntry)) return [jsEntry];
  return ["--import", "tsx", fileURLToPath(new URL("./server-main.ts", import.meta.url))];
}

/**
 * Starts the daemon detached from this process's lifetime. POSIX uses a plain detached spawn.
 * Windows additionally needs a new console and zero handle inheritance: Node can create neither,
 * so a short-lived `Start-Process` shim performs the launch with the daemon argv carried as a
 * Base64 JSON payload (single-quote-safe charset only). Without this, any supervising Windows
 * shell that waits on its captured pipes or console would hang until the viewer is stopped.
 */
function spawnViewerDaemon(daemonArguments: string[]): void {
  if (process.platform === "win32") {
    const payload = Buffer.from(JSON.stringify({ node: process.execPath, args: daemonArguments.map((argument) => `"${argument}"`) }), "utf8").toString("base64");
    const script = `$j=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;Start-Process -WindowStyle Hidden -FilePath $j.node -ArgumentList $j.args`;
    const shim = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { cwd: viewerPackageRoot(), stdio: "ignore", windowsHide: true });
    shim.unref();
    return;
  }
  const child = spawn(process.execPath, daemonArguments, {
    cwd: viewerPackageRoot(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Launches the persistent localhost viewer for a workspace (idempotent per workspace) as a
 * detached child that survives the invoking CLI/agent process, then waits for its health probe.
 */
export async function startViewer(workspaceRoot: string, options: ViewerStartOptions = {}): Promise<ViewerStartResult> {
  const root = resolve(workspaceRoot);
  const existing = await viewerStatus(root);
  if (existing.status === "running") {
    return { status: "already-running", url: existing.record.url, host: existing.record.host, port: existing.record.port, pid: existing.record.pid, record: existing.record };
  }
  if (existing.status === "stale-record") await rm(viewerRecordPath(root), { force: true });
  const port = await selectPort(options.port);
  const shutdownToken = randomBytes(24).toString("hex");
  const instanceId = randomBytes(12).toString("hex");
  mkdirSync(viewerRuntimeDirectory(root), { recursive: true });
  const entryArguments = [...viewerServerEntryArguments(), root, String(port), shutdownToken, instanceId];
  (options.spawnServer ?? spawnViewerDaemon)(entryArguments);
  const deadline = Date.now() + (options.readyTimeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    const record = await readRuntimeRecord(root);
    if (record && record.instanceId === instanceId && await probeViewerHealth(record, root)) {
      return { status: "started", url: record.url, host: record.host, port: record.port, pid: record.pid, record };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`viewer server for ${root} did not become healthy in time; inspect ${join(viewerRuntimeDirectory(root), "server.log")}`);
}

/**
 * Stops the viewer instance recorded for this workspace via its token-protected shutdown
 * endpoint; never kills an arbitrary PID. Stale records are cleaned without signalling.
 */
export async function stopViewer(workspaceRoot: string): Promise<ViewerStopResult> {
  const root = resolve(workspaceRoot);
  const record = await readRuntimeRecord(root);
  if (!record) return { status: "not-running" };
  if (!await probeViewerHealth(record, root)) {
    await rm(viewerRecordPath(root), { force: true });
    return { status: "stale-record-cleared" };
  }
  await fetchWithTimeout(`${record.url}shutdown`, { method: "POST", headers: { "x-mesh2threejs-shutdown-token": record.shutdownToken } }, 3000);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!await probeViewerHealth(record, root)) {
      await rm(viewerRecordPath(root), { force: true });
      return { status: "stopped" };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`viewer server at ${record.url} did not shut down within the timeout`);
}

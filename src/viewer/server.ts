import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { IncomingMessage } from "node:http";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { auditCandidateModule, type CandidateModuleAudit } from "../core/candidate.js";
import { getProfileContract } from "../core/contracts.js";
import { neutralPoseForProfile } from "../core/orchestration.js";
import type { GenericSubjectContract } from "../profiles/generic.js";
import type { ProfileId } from "../types.js";

export interface ViewerServerOptions {
  workspaceRoot: string;
  port: number;
  shutdownToken: string;
  instanceId: string;
  host?: string;
  startedAt?: number;
  /** Authority-bound trusted scene binding (closure plan §9.F4). */
  trustedScene?: { path: string; sha256: string };
}

export interface ViewerServerHandle {
  server: Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export const VIEWER_HOST = "127.0.0.1";
export const VIEWER_DEFAULT_PORT = 5173;

function sha256OfBuffer(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Static browser client shipped with the package (repo-root `viewer/`). */
export function viewerAssetsDirectory(): string {
  return fileURLToPath(new URL("../../viewer/", import.meta.url));
}

/** Package root used as the detached server's working directory. */
export function viewerPackageRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

interface VendorRoots {
  build: string;
  jsm: string;
}

function resolveThreeVendorRoots(): VendorRoots {
  const entry = fileURLToPath(import.meta.resolve("three"));
  const build = dirname(entry);
  return { build, jsm: join(build, "..", "examples", "jsm") };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, secureHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }));
  response.end(body);
}

function sendText(response: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  response.writeHead(status, secureHeaders({ "content-type": contentType, "cache-control": "no-store" }));
  response.end(body);
}

/** CSP appropriate to a static localhost viewer: no remote fetches, no inline script execution beyond the app bundle. */
function secureHeaders(base: Record<string, string>): Record<string, string> {
  return {
    ...base,
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
  };
}

/** Resolves a request-relative path strictly inside `root`; rejects traversal, separators, and hidden dot segments. */
function safeJoin(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  if (segments.some((segment) => segment.startsWith("."))) return null;
  const target = resolve(root, ...segments);
  const relation = relative(root, target);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return null;
  return target;
}

interface ViewerWorkspaceContext {
  profile: ProfileId;
  model: string;
  modelEntry: string;
  state: { activePhase?: string; status?: string; candidateHash?: string | null; mirrorOfRun?: { runId?: string } | null };
  subjectContract?: GenericSubjectContract;
}

/**
 * Reads the small live workspace metadata the viewer needs (project selection, durable state,
 * subject contract) without resuming/hash-verifying the full workspace: the viewer is an
 * inspection surface and must stay cheap per request and per poll.
 */
async function loadViewerContext(workspaceRoot: string): Promise<ViewerWorkspaceContext> {
  const project = JSON.parse(await readFile(join(workspaceRoot, "project.json"), "utf8")) as { profile?: ProfileId; model?: string; subjectContract?: string };
  if (project.profile !== "tank" && project.profile !== "generic") throw new Error("workspace project declares an unsupported profile");
  if (typeof project.model !== "string" || !project.model) throw new Error("workspace project has no authored model selection");
  let state: ViewerWorkspaceContext["state"] = {};
  try {
    state = JSON.parse(await readFile(join(workspaceRoot, ".mesh2threejs", "state.json"), "utf8")) as ViewerWorkspaceContext["state"];
  } catch { /* the durable state may be absent in a partially initialized workspace */ }
  let subjectContract: GenericSubjectContract | undefined;
  if (project.subjectContract && project.profile === "generic") {
    try {
      const contractPath = resolve(workspaceRoot, project.subjectContract);
      if (!relative(workspaceRoot, contractPath).startsWith("..")) {
        subjectContract = JSON.parse(await readFile(contractPath, "utf8")) as GenericSubjectContract;
      }
    } catch { /* a missing contract mirrors "no declared generic controls" for display */ }
  }
  return { profile: project.profile, model: project.model, modelEntry: resolve(workspaceRoot, project.model), state, ...(subjectContract ? { subjectContract } : {}) };
}

interface CachedAudit {
  at: number;
  audit: CandidateModuleAudit | null;
  error: string | null;
}

const AUDIT_TTL_MS = 300;

/** Locates the newest trusted viewer-scene artifact bound to the current candidate hash. */
async function loadTrustedSceneArtifact(workspaceRoot: string, candidateHash: string | null): Promise<{ candidateHash: string | null; sceneHash: string; serialization: unknown }> {
  const capturesDirectory = join(workspaceRoot, ".mesh2threejs", "captures");
  let names: string[] = [];
  try {
    const { readdir } = await import("node:fs/promises");
    names = (await readdir(capturesDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  } catch { /* no captures yet */ }
  for (const name of names.filter((entry) => entry.startsWith("render-"))) {
    const artifactPath = join(capturesDirectory, name, "viewer-scene.json");
    try {
      const parsed = JSON.parse(await readFile(artifactPath, "utf8")) as { candidateHash?: string; sceneHash?: string; serialization?: unknown };
      if (!parsed.serialization || !parsed.sceneHash) continue;
      if (candidateHash && parsed.candidateHash !== candidateHash) continue;
      return { candidateHash: parsed.candidateHash ?? null, sceneHash: parsed.sceneHash, serialization: parsed.serialization };
    } catch { /* inspect the next run */ }
  }
  throw new Error("no trusted viewer-scene artifact is available for the current candidate; run review-ready or render first");
}

/**
 * Minimal localhost preview server for the live audited candidate graph. It serves only the
 * viewer app assets, the vendored Three.js browser modules, and the exact files the candidate
 * audit admits; it never exposes refs/, .mesh2threejs/, or any other workspace bytes.
 */
export async function createViewerServer(options: ViewerServerOptions): Promise<ViewerServerHandle> {
  const host = options.host ?? VIEWER_HOST;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error("the viewer only binds the loopback interface");
  const workspaceRoot = resolve(options.workspaceRoot);
  const workspaceInfo = await stat(workspaceRoot).catch(() => null);
  if (!workspaceInfo?.isDirectory()) throw new Error(`viewer workspace does not exist: ${workspaceRoot}`);
  const assets = viewerAssetsDirectory();
  const vendor = resolveThreeVendorRoots();
  const startedAt = options.startedAt ?? Date.now();
  let cachedAudit: CachedAudit = { at: 0, audit: null, error: "no audit performed yet" };

  const auditNow = async (): Promise<CachedAudit> => {
    try {
      const context = await loadViewerContext(workspaceRoot);
      const audit = await auditCandidateModule(context.modelEntry);
      cachedAudit = { at: Date.now(), audit, error: audit.passed ? null : audit.findings.map((finding) => `${finding.code}: ${finding.message}`).join("; ") };
    } catch (error) {
      cachedAudit = { at: Date.now(), audit: null, error: error instanceof Error ? error.message : String(error) };
    }
    return cachedAudit;
  };
  const cachedAuditNow = async (): Promise<CachedAudit> => (Date.now() - cachedAudit.at > AUDIT_TTL_MS ? auditNow() : cachedAudit);

  const serveFile = async (response: ServerResponse, path: string): Promise<void> => {
    try {
      const bytes = await readFile(path);
      const extension = path.slice(path.lastIndexOf("."));
      response.writeHead(200, secureHeaders({ "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream", "cache-control": "no-store" }));
      response.end(bytes);
    } catch {
      sendText(response, 404, "not found");
    }
  };

  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = request.method ?? "GET";
    if (method === "GET" && path === "/health") {
      sendJson(response, 200, { status: "ok", instanceId: options.instanceId, workspace: workspaceRoot, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
      return;
    }
    if (method === "POST" && path === "/shutdown") {
      if (request.headers["x-mesh2threejs-shutdown-token"] !== options.shutdownToken) {
        sendJson(response, 403, { status: "forbidden" });
        return;
      }
      sendJson(response, 202, { status: "shutting-down" });
      setImmediate(() => { void close(); });
      return;
    }
    if (method !== "GET") {
      sendJson(response, 404, { status: "not-found" });
      return;
    }
    if (path === "/") return serveFile(response, join(assets, "index.html"));
    if (path === "/assets/viewer.js") return serveFile(response, join(assets, "viewer.js"));
    // Trusted runs (workspace bound to a run authority) NEVER receive candidate JavaScript:
    // the viewer displays the trusted serialized evaluated scene instead (§14).
    const context = await loadViewerContext(workspaceRoot).catch(() => null);
    const trusted = Boolean(context?.state.mirrorOfRun);
    if (path === "/api/model") {
      try {
        if (!context) throw new Error("workspace context is unavailable");
        if (trusted) {
          const controls = context.profile === "generic" ? context.subjectContract?.articulation ?? [] : getProfileContract(context.profile).articulation;
          const neutral = neutralPoseForProfile(context.profile, context.subjectContract);
          sendJson(response, 200, {
            schemaVersion: 1,
            status: "ok",
            mode: "trusted-serialization",
            profile: context.profile,
            model: context.model,
            sceneUrl: "/api/scene",
            sourceHash: null,
            error: null,
            activePhase: context.state.activePhase ?? null,
            taskStatus: context.state.status ?? null,
            candidateHash: context.state.candidateHash ?? null,
            articulation: controls.map((control) => ({
              control: control.control,
              samples: control.samples,
              min: Math.min(...control.samples, 0),
              max: Math.max(...control.samples, 0),
              neutral: neutral[control.control] ?? 0,
            })),
          });
          return;
        }
        const audit = await cachedAuditNow();
        const controls = context.profile === "generic" ? context.subjectContract?.articulation ?? [] : getProfileContract(context.profile).articulation;
        const neutral = neutralPoseForProfile(context.profile, context.subjectContract);
        sendJson(response, 200, {
          schemaVersion: 1,
          status: audit.audit?.passed ? "ok" : "invalid",
          mode: "development-candidate-module",
          profile: context.profile,
          model: context.model,
          entry: `/candidate/${basename(context.modelEntry)}`,
          sourceHash: audit.audit?.passed ? audit.audit.sourceHash : null,
          error: audit.error,
          activePhase: context.state.activePhase ?? null,
          taskStatus: context.state.status ?? null,
          candidateHash: context.state.candidateHash ?? null,
          articulation: controls.map((control) => ({
            control: control.control,
            samples: control.samples,
            min: Math.min(...control.samples, 0),
            max: Math.max(...control.samples, 0),
            neutral: neutral[control.control] ?? 0,
          })),
        });
      } catch (error) {
        sendJson(response, 200, { schemaVersion: 1, status: "unavailable", error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (path === "/api/scene") {
      try {
        if (!context) throw new Error("workspace context is unavailable");
        // §9.F4: a trusted run serves ONLY the authority-bound scene file, re-hashed on
        // every request. Workspace-tampered bytes yield TRUSTED_VIEWER_ARTIFACT_DRIFT.
        if (options.trustedScene) {
          const bytes = await readFile(options.trustedScene.path);
          const liveSha = sha256OfBuffer(bytes);
          if (liveSha !== options.trustedScene.sha256) throw new Error("TRUSTED_VIEWER_ARTIFACT_DRIFT: the bound review scene changed after review-ready; rerun review-ready to regenerate captures");
          const parsed = JSON.parse(bytes.toString("utf8")) as { candidateHash?: string; sceneHash?: string; serialization?: unknown };
          if (!parsed.serialization || !parsed.sceneHash) throw new Error("bound scene artifact is malformed; rerun review-ready");
          sendJson(response, 200, { schemaVersion: 1, status: "ok", candidateHash: parsed.candidateHash ?? null, sceneHash: parsed.sceneHash, serialization: parsed.serialization });
          return;
        }
        const scene = await loadTrustedSceneArtifact(workspaceRoot, context.state.candidateHash ?? null);
        sendJson(response, 200, { schemaVersion: 1, status: "ok", ...scene });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(response, 200, { schemaVersion: 1, status: "unavailable", ...(message.startsWith("TRUSTED_VIEWER_ARTIFACT_DRIFT") ? { code: "TRUSTED_VIEWER_ARTIFACT_DRIFT" } : {}), error: message });
      }
      return;
    }
    if (path === "/api/version") {
      if (trusted) {
        sendJson(response, 200, { status: "ok", sourceHash: null, trustedScene: true, observedAt: new Date().toISOString() });
        return;
      }
      const audit = await cachedAuditNow();
      sendJson(response, 200, audit.audit?.passed
        ? { status: "ok", sourceHash: audit.audit.sourceHash, observedAt: new Date().toISOString() }
        : { status: "invalid", error: audit.error, observedAt: new Date().toISOString() });
      return;
    }
    if (path.startsWith("/candidate/")) {
      if (trusted || !context) return sendText(response, 404, "not found");
      const rel = path.slice("/candidate/".length);
      const audit = await cachedAuditNow();
      if (!audit.audit?.passed) return sendText(response, 409, "candidate audit is currently failing; fix the candidate source");
      const entryDir = dirname(context.modelEntry);
      const admitted = new Set(audit.audit.candidateFiles.map((file) => file.path));
      if (!admitted.has(rel)) return sendText(response, 404, "not part of the audited candidate graph");
      const target = safeJoin(entryDir, rel);
      if (!target) return sendText(response, 404, "not found");
      return serveFile(response, target);
    }
    if (path.startsWith("/vendor/three/examples/jsm/")) {
      const target = safeJoin(vendor.jsm, path.slice("/vendor/three/examples/jsm/".length));
      if (!target) return sendText(response, 404, "not found");
      return serveFile(response, target);
    }
    if (path.startsWith("/vendor/three/")) {
      const target = safeJoin(vendor.build, path.slice("/vendor/three/".length));
      if (!target) return sendText(response, 404, "not found");
      return serveFile(response, target);
    }
    sendJson(response, 404, { status: "not-found" });
  };

  const server = createServer((request, response) => {
    respond(request, response).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { status: "error", error: error instanceof Error ? error.message : String(error) });
      else response.end();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, host, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://${host}:${port}/`;
  const close = (): Promise<void> => new Promise((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); });
  return { server, host, port, url, close };
}

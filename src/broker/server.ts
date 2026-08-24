import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DirectoryRunAuthorityStore,
  InMemoryRunAuthorityStore,
  TrustedRunAuthority,
  mirroredTaskState,
  stateMirrorFor,
  type RunAuthorityRecord,
  type RunAuthorityStore,
} from "../core/run-authority.js";
import { establishToolchain, sanitizeLaunchEnvironment, assertSafeLaunchEnvironment } from "../core/toolchain.js";
import { assertCapability, classifyOperation, type Capability } from "../core/capabilities.js";
import { IMPLEMENTED_BUILDER_ROUTES, RECOGNIZED_ADMIN_ROUTES } from "./operations.js";
import { TrustedPipeline } from "../trusted/pipeline.js";
import type { TaskState } from "../core/state.js";

/**
 * Trusted reconstruction broker (closure plan §4/§10.G). Launched OUTSIDE builder command
 * control by the user/host from a packaged installation; owns the canonical run-authority
 * store and exposes ONLY operation-level routes backed by the trusted pipeline
 * (src/trusted/pipeline.ts). There is no generic transition/runtime-record endpoint: no
 * caller can submit a passing fact, evidence, isolation label, replay record, packet hash,
 * or certification state. Human/admin operations require the separate admin token,
 * delivered to the launching user's console and never persisted beside builder data.
 */

export interface BrokerOptions {
  /** Storage root for canonical authority records; MUST be outside builder-writable space. */
  storeRoot?: string;
  /** Package root used for toolchain identity; defaults to this installation. */
  packageRoot?: string;
  port?: number;
  host?: string;
  /** Test hook: in-memory store instead of directory-backed storage. */
  store?: RunAuthorityStore;
  /**
   * Test hook: inject a verified toolchain instead of establishing from disk. Test brokers
   * may mark it trusted to exercise certification; production launches never pass this.
   */
  toolchainOverride?: typeof import("../core/toolchain.js").establishToolchain extends (...args: never[]) => Promise<infer T> ? T : never;
}

export interface BrokerHandle {
  url: string;
  port: number;
  builderToken: string;
  adminToken: string;
  toolchainId: string;
  trustedToolchain: boolean;
  close: () => Promise<void>;
  /** Test/diagnostic injection points INSIDE the trusted boundary (never builder RPC). */
  authority: TrustedRunAuthority;
  pipeline: TrustedPipeline;
}

interface BrokerRequest {
  operation: string;
  runId?: string;
  token?: string;
  payload?: unknown;
}

/** Builder-safe operations are executed for either capability; admin ops require human-admin.
 *  Both sets derive from the canonical registry (src/broker/operations.ts). */
const BUILDER_SAFE_ROUTES = IMPLEMENTED_BUILDER_ROUTES;

const ADMIN_ROUTES = RECOGNIZED_ADMIN_ROUTES;

export async function startBroker(options: BrokerOptions = {}): Promise<BrokerHandle> {
  assertSafeLaunchEnvironment();
  void sanitizeLaunchEnvironment();
  const packageRoot = options.packageRoot ? resolve(options.packageRoot) : resolve(import.meta.dirname, "..", "..");
  const toolchain = options.toolchainOverride ?? await establishToolchain(packageRoot);
  const store = options.store ?? (options.storeRoot ? new DirectoryRunAuthorityStore(options.storeRoot) : new InMemoryRunAuthorityStore());
  const authority = new TrustedRunAuthority(store);
  const pipeline = new TrustedPipeline({ authority, packageRoot, ...(options.toolchainOverride ? { toolchain: options.toolchainOverride } : {}) });
  // Bind the already-established toolchain so the pipeline verifies the SAME bytes.
  if (options.toolchainOverride) (pipeline as unknown as { toolchainValue: unknown }).toolchainValue = toolchain;
  const builderToken = randomBytes(24).toString("hex");
  const adminToken = randomBytes(24).toString("hex");

  const respond = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(payload);
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== "POST") {
        respond(res, 405, { error: "broker accepts POST only" });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as BrokerRequest;
      // Token IS the capability carrier: builder token -> builder capability; admin token
      // (printed only to the launching user's console) -> human/admin capability.
      const capability: Capability | null = request.token === adminToken ? "human-admin" : request.token === builderToken ? "builder" : null;
      if (!capability) {
        respond(res, 401, { error: "invalid or missing broker token" });
        return;
      }
      const operation = request.operation ?? "";
      if (ADMIN_ROUTES.has(operation)) {
        try {
          assertCapability(operation, capability);
        } catch {
          respond(res, 403, { error: `operation ${operation} requires the human/admin channel; builders cannot invoke it` });
          return;
        }
      } else if (!BUILDER_SAFE_ROUTES.has(operation)) {
        respond(res, 400, { error: `unknown broker operation: ${operation}` });
        return;
      }
      void classifyOperation;
      const runId = request.runId;
      switch (operation) {
        case "find-runs":
          respond(res, 200, { runs: await store.find() });
          return;
        case "read-run":
          requireRun(runId);
          respond(res, 200, { record: await authority.readRun(runId!) });
          return;
        case "begin-run": {
          const payload = (request.payload ?? {}) as { workspace?: string };
          if (!payload.workspace) throw new Error("begin-run requires payload.workspace");
          respond(res, 200, await pipeline.beginRun({ workspaceRoot: payload.workspace }, capability));
          return;
        }
        case "create-workspace-run": {
          const payload = (request.payload ?? {}) as { workspaceRoot?: string; goal?: string; oraclePath?: string; workspaceId?: string };
          if (!payload.workspaceRoot || !payload.goal || !payload.oraclePath) throw new Error("create-workspace-run requires payload.workspaceRoot, payload.goal and payload.oraclePath");
          respond(res, 200, await pipeline.createWorkspaceRun({ workspaceRoot: payload.workspaceRoot, goal: payload.goal, oraclePath: payload.oraclePath, ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}) }, capability));
          return;
        }
        case "status":
          requireRun(runId);
          respond(res, 200, await pipeline.status(runId!));
          return;
        case "next":
          requireRun(runId);
          respond(res, 200, await pipeline.next(runId!));
          return;
        case "onboard-oracle":
          requireRun(runId);
          respond(res, 200, await pipeline.onboardOracle(runId!, (request.payload ?? {}) as never, capability));
          return;
        case "repair-oracle":
          requireRun(runId);
          respond(res, 200, await pipeline.repairOracle(runId!, (request.payload ?? {}) as never));
          return;
        case "register":
          requireRun(runId);
          respond(res, 200, await pipeline.register(runId!, (request.payload ?? {}) as never));
          return;
        case "oracle-sanity":
          requireRun(runId);
          respond(res, 200, await pipeline.oracleSanity(runId!));
          return;
        case "derive":
          requireRun(runId);
          respond(res, 200, await pipeline.derive(runId!, (request.payload ?? {}) as { quality?: "aggressive" | "balanced" | "conservative" }, capability));
          return;
        case "gate":
          requireRun(runId);
          respond(res, 200, await pipeline.gate(runId!, (request.payload ?? {}) as { global?: boolean }, capability));
          return;
        case "lock":
          requireRun(runId);
          respond(res, 200, await pipeline.lock(runId!, (request.payload as { phase?: string } | undefined)?.phase, capability));
          return;
        case "reopen":
          requireRun(runId);
          respond(res, 200, await pipeline.reopen(runId!, (request.payload ?? {}) as { phase: string; reason: string }, capability));
          return;
        case "render-quick":
          requireRun(runId);
          respond(res, 200, await pipeline.renderQuick(runId!));
          return;
        case "probe":
          requireRun(runId);
          respond(res, 200, await pipeline.probe(runId!));
          return;
        case "workorders":
          requireRun(runId);
          respond(res, 200, await pipeline.workorders(runId!));
          return;
        case "review-ready":
          requireRun(runId);
          respond(res, 200, await pipeline.reviewReady(runId!));
          return;
        case "viewer-status":
          requireRun(runId);
          respond(res, 200, { viewerStartApproved: (await authority.readRun(runId!)).viewerStartApproved });
          return;
        case "approve-review":
          requireRun(runId);
          respond(res, 200, await pipeline.approveReview(runId!, ((request.payload ?? {}) as { method?: "broker-console" }), capability));
          return;
        case "approve-viewer-start":
          requireRun(runId);
          respond(res, 200, await pipeline.approveViewerStart(runId!, capability));
          return;
        case "viewer-start":
          requireRun(runId);
          respond(res, 200, await pipeline.viewerStart(runId!, capability));
          return;
        case "trusted-finalize":
          requireRun(runId);
          respond(res, 200, await pipeline.finalize(runId!, capability));
          return;
        case "certify":
        case "record-human-approval":
          // Deliberately unreachable for builders (403 above); admins use the operation-level
          // routes (approve-review / trusted-finalize) instead of raw authority calls.
          respond(res, 400, { error: `${operation} is served by its operation-level route` });
          return;
        default:
          respond(res, 400, { error: `unhandled broker operation: ${operation}` });
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      respond(res, 422, { error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) });
    }
  });

  const requireRun = (value: string | undefined): void => {
    if (!value) throw new Error("runId required");
  };

  const port = await new Promise<number>((resolvePort) => {
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : options.port ?? 0);
    });
  });

  // §10.G3: only a BUILDER connection descriptor is persisted, and it contains no admin
  // secret. The admin token goes to the operator's console/human channel only.
  const persistBuilderDescriptor = async (): Promise<void> => {
    if (!options.storeRoot) return;
    await mkdir(options.storeRoot, { recursive: true });
    await writeFile(join(options.storeRoot, "broker-builder-connection.json"), `${JSON.stringify({ builderToken, url: `http://127.0.0.1:${port}` }, null, 2)}\n`, { flag: "wx" });
  };
  await persistBuilderDescriptor();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    builderToken,
    adminToken,
    toolchainId: toolchain.toolchainId,
    trustedToolchain: toolchain.trustedToolchain,
    authority,
    pipeline,
    close: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/** Mirrors an authoritative record into workspace-visible TaskState form. */
export function mirrorForWorkspace(record: RunAuthorityRecord): { state: TaskState; mirror: ReturnType<typeof stateMirrorFor> } {
  return { state: mirroredTaskState(record), mirror: stateMirrorFor(record) };
}

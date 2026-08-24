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
  type BuilderAction,
  type RunAuthorityRecord,
  type RuntimeRecord,
  type RunAuthorityStore,
} from "../core/run-authority.js";
import { establishToolchain, sanitizeLaunchEnvironment, assertSafeLaunchEnvironment } from "../core/toolchain.js";
import type { Capability } from "../core/capabilities.js";
import type { TaskState } from "../core/state.js";

/**
 * Trusted reconstruction broker (§6.1). Launched OUTSIDE builder command control by the
 * user/host from a packaged installation; owns the canonical run-authority store and
 * exposes builder-safe operations only. Human/admin operations require the separate admin
 * token, delivered to the launching user's console and never to the builder.
 *
 * Launch hygiene: startup rejects unsafe Node configuration and records runtime provenance;
 * toolchain bytes are re-verified from disk against the manifest computed at startup.
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
}

export interface BrokerHandle {
  url: string;
  port: number;
  builderToken: string;
  adminToken: string;
  toolchainId: string;
  close: () => Promise<void>;
  /** Test-only injection point for executing pipeline work inside the trusted boundary. */
  authority: TrustedRunAuthority;
}

interface BrokerRequest {
  operation: string;
  runId?: string;
  capability?: Capability;
  token?: string;
  payload?: unknown;
}



export async function startBroker(options: BrokerOptions = {}): Promise<BrokerHandle> {
  assertSafeLaunchEnvironment();
  const sanitized = sanitizeLaunchEnvironment();
  void sanitized;
  const packageRoot = options.packageRoot ? resolve(options.packageRoot) : resolve(import.meta.dirname, "..", "..");
  const toolchain = await establishToolchain(packageRoot);
  const store = options.store ?? (options.storeRoot ? new DirectoryRunAuthorityStore(options.storeRoot) : new InMemoryRunAuthorityStore());
  const authority = new TrustedRunAuthority(store);
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
      const context = { requestedBy: capability };
      switch (request.operation) {
        case "read-run": {
          if (!request.runId) throw new Error("runId required");
          respond(res, 200, { record: await authority.readRun(request.runId) });
          return;
        }
        case "find-runs": {
          respond(res, 200, { runs: await store.find() });
          return;
        }
        case "transition": {
          if (!request.runId) throw new Error("runId required");
          const record = await authority.applyBuilderTransition(request.runId, request.payload as BuilderAction, context);
          respond(res, 200, { record });
          return;
        }
        case "runtime-record": {
          if (!request.runId) throw new Error("runId required");
          const record = await authority.applyRuntimeRecord(request.runId, request.payload as RuntimeRecord);
          respond(res, 200, { record });
          return;
        }
        case "record-human-approval": {
          if (!request.runId) throw new Error("runId required");
          const approval = request.payload as Parameters<TrustedRunAuthority["recordHumanApproval"]>[1];
          const record = await authority.recordHumanApproval(request.runId, approval, context);
          respond(res, 200, { record });
          return;
        }
        case "certify": {
          if (!request.runId) throw new Error("runId required");
          const record = await authority.certify(request.runId, context);
          respond(res, 200, { record });
          return;
        }
        default:
          respond(res, 400, { error: `unknown broker operation: ${String(request.operation)}` });
      }
    } catch (error) {
      respond(res, 422, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const port = await new Promise<number>((resolvePort) => {
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : options.port ?? 0);
    });
  });

  const persistTokens = async (): Promise<void> => {
    if (!options.storeRoot) return;
    await mkdir(options.storeRoot, { recursive: true });
    await writeFile(join(options.storeRoot, "broker-tokens.json"), `${JSON.stringify({ builderToken, adminToken, url: `http://127.0.0.1:${port}` }, null, 2)}\n`, { flag: "wx" });
  };
  await persistTokens();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    builderToken,
    // The ADMIN token is the human channel: it goes to the operator's console only. Hosts
    // that cannot keep it away from builder tools cannot provide trusted certification.
    adminToken,
    toolchainId: toolchain.toolchainId,
    authority,
    close: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/** Mirrors an authoritative record into workspace-visible TaskState form. */
export function mirrorForWorkspace(record: RunAuthorityRecord): { state: TaskState; mirror: ReturnType<typeof stateMirrorFor> } {
  return { state: mirroredTaskState(record), mirror: stateMirrorFor(record) };
}

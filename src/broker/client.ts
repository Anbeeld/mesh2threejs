import type { RunAuthorityRecord } from "../core/run-authority.js";

/**
 * Typed client for the trusted reconstruction broker (closure plan §4.A5). Adapters and
 * tooling call THESE operation-level methods — never generic state/record transitions.
 * There is deliberately NO client method that submits runtime facts, evidence, isolation
 * classifications, replay records, packet hashes, or approval payloads.
 */
export class BrokerClient {
  constructor(private readonly options: { url: string; token: string }) {}

  private async call<T>(operation: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${this.options.url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation, token: this.options.token, ...body }),
    });
    const payload = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(payload.error ?? `broker request failed: ${response.status}`);
    return payload;
  }

  /** Builder-safe: begins an autonomous safe-default run; the request names a workspace only. */
  beginRun(workspace: string): Promise<{ runId: string }> {
    return this.call("begin-run", { payload: { workspace } });
  }

  findRuns(): Promise<{ runs: Array<Pick<RunAuthorityRecord, "runId" | "workspaceRoot" | "status">> }> {
    return this.call("find-runs");
  }

  readRun(runId: string): Promise<{ record: RunAuthorityRecord }> {
    return this.call("read-run", { runId });
  }

  status(runId: string): Promise<Record<string, unknown>> {
    return this.call("status", { runId });
  }

  next(runId: string): Promise<Record<string, unknown>> {
    return this.call("next", { runId });
  }

  onboardOracle(runId: string, config: unknown): Promise<Record<string, unknown>> {
    return this.call("onboard-oracle", { runId, payload: config });
  }

  repairOracle(runId: string, config: unknown): Promise<Record<string, unknown>> {
    return this.call("repair-oracle", { runId, payload: config });
  }

  register(runId: string, expectation: unknown): Promise<Record<string, unknown>> {
    return this.call("register", { runId, payload: expectation });
  }

  oracleSanity(runId: string): Promise<Record<string, unknown>> {
    return this.call("oracle-sanity", { runId });
  }

  derive(runId: string, quality?: "aggressive" | "balanced" | "conservative"): Promise<Record<string, unknown>> {
    return this.call("derive", { runId, ...(quality ? { payload: { quality } } : {}) });
  }

  gate(runId: string): Promise<Record<string, unknown>> {
    return this.call("gate", { runId });
  }

  lock(runId: string, phase?: string): Promise<Record<string, unknown>> {
    return this.call("lock", { runId, ...(phase ? { payload: { phase } } : {}) });
  }

  reopen(runId: string, phase: string, reason: string): Promise<Record<string, unknown>> {
    return this.call("reopen", { runId, payload: { phase, reason } });
  }

  reviewReady(runId: string): Promise<Record<string, unknown>> {
    return this.call("review-ready", { runId });
  }

  // ---- human/admin channel (admin token required; builder tokens are rejected server-side) ----

  approveReview(runId: string): Promise<{ status: string; approvedAt?: string }> {
    return this.call("approve-review", { runId, payload: {} });
  }

  approveViewerStart(runId: string): Promise<{ status: string }> {
    return this.call("approve-viewer-start", { runId });
  }

  finalize(runId: string): Promise<{ status: string; runId: string }> {
    return this.call("trusted-finalize", { runId });
  }
}

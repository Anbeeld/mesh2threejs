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

  /** Read-only oracle facts for autonomous onboarding (§7.1). */
  probe(runId: string): Promise<Record<string, unknown>> {
    return this.call("probe", { runId });
  }

  /** Current authoritative failing workorders from canonical trusted evidence (§7.2). */
  workorders(runId: string): Promise<Record<string, unknown>> {
    return this.call("workorders", { runId });
  }

  /** Trusted active-phase diagnostic render; never review/certification evidence (§7.3). */
  // ---- stylized-authored mode (design §26) ----

  authorStatus(runId: string): Promise<Record<string, unknown>> {
    return this.call("author-status", { runId });
  }

  authorCompile(runId: string): Promise<Record<string, unknown>> {
    return this.call("author-compile", { runId });
  }

  authorCheck(runId: string, scope?: string): Promise<Record<string, unknown>> {
    return this.call("author-check", { runId, ...(scope ? { payload: { scope } } : {}) });
  }

  authorCheckpoint(runId: string, input: { kind: string; assessment?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return this.call("author-checkpoint", { runId, payload: input });
  }

  authorMeasure(runId: string, semantics?: string[]): Promise<Record<string, unknown>> {
    return this.call("author-measure", { runId, ...(semantics ? { payload: { semantics } } : {}) });
  }

  referenceScene(runId: string): Promise<Record<string, unknown>> {
    return this.call("reference-scene", { runId });
  }

  validateFrozen(runId: string): Promise<Record<string, unknown>> {
    return this.call("validate-frozen", { runId });
  }

  freezeConstruction(runId: string): Promise<Record<string, unknown>> {
    return this.call("freeze-construction", { runId });
  }

  reopenAuthoring(runId: string, reason: string): Promise<Record<string, unknown>> {
    return this.call("reopen-authoring", { runId, payload: { reason } });
  }

  renderQuick(runId: string): Promise<Record<string, unknown>> {
    return this.call("render-quick", { runId });
  }

  viewerStatus(runId: string): Promise<{ viewerStartApproved: boolean }> {
    return this.call("viewer-status", { runId });
  }

  // ---- human/admin channel (admin token required; builder tokens are rejected server-side) ----

  /** TRUSTED INTAKE (remaining closure §6.1): host/user pins goal + oracle before builder control. */
  createWorkspaceRun(input: { workspaceRoot: string; goal: string; oraclePath: string; workspaceId?: string; constructionMode?: "stylized-authored" | "derived-faithful"; images?: string[] }): Promise<{ runId: string; intake?: string }> {
    return this.call("create-workspace-run", { payload: input });
  }

  approveReview(runId: string): Promise<{ status: string; approvedAt?: string }> {
    return this.call("approve-review", { runId, payload: {} });
  }

  approveViewerStart(runId: string): Promise<{ status: string }> {
    return this.call("approve-viewer-start", { runId });
  }

  trustedFinalize(runId: string): Promise<{ status: string; runId: string }> {
    return this.call("trusted-finalize", { runId });
  }

  viewerStart(runId: string): Promise<{ status: string; url?: string }> {
    return this.call("viewer-start", { runId });
  }
}

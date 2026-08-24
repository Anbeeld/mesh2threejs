import type { BuilderAction, RunAuthorityRecord, RuntimeRecord } from "../core/run-authority.js";
import type { HumanApproval } from "../core/run-authority.js";
import type { Capability } from "../core/capabilities.js";

/**
 * Typed client for the trusted reconstruction broker. Adapters and tooling call THIS, never
 * `node dist/cli.js` inside a writable checkout, when they need trusted operations.
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

  readRun(runId: string): Promise<{ record: RunAuthorityRecord }> {
    return this.call("read-run", { runId });
  }

  findRuns(): Promise<{ runs: Array<Pick<RunAuthorityRecord, "runId" | "workspaceRoot" | "status">> }> {
    return this.call("find-runs");
  }

  transition(runId: string, payload: BuilderAction): Promise<{ record: RunAuthorityRecord }> {
    return this.call("transition", { runId, payload });
  }

  runtimeRecord(runId: string, payload: RuntimeRecord): Promise<{ record: RunAuthorityRecord }> {
    return this.call("runtime-record", { runId, payload });
  }

  recordHumanApproval(runId: string, approval: Omit<HumanApproval, "approvedAt">, capability: Capability = "human-admin"): Promise<{ record: RunAuthorityRecord }> {
    void capability;
    return this.call("record-human-approval", { runId, payload: approval });
  }

  certify(runId: string): Promise<{ record: RunAuthorityRecord }> {
    return this.call("certify", { runId });
  }
}

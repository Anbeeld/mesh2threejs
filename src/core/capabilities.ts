/**
 * Command/capability partition. Authorization lives in this tool boundary, not in prose:
 * every mutating CLI/broker operation is classified, and the runtime rejects operations
 * above the caller's capability. Builders get builder-safe operations only; human/admin
 * operations require a capability channel the builder model does not possess.
 */

export type Capability = "builder" | "human-admin";

/** Operations a reconstruction builder may invoke autonomously. */
export const BUILDER_OPERATIONS = new Set([
  "begin-run",
  "status",
  "next",
  "find-runs",
  "read-run",
  "probe",
  "route",
  "onboard-oracle",
  "repair-oracle",
  "register",
  "oracle-sanity",
  "derive",
  "gate",
  "lock",
  "reopen",
  "audit-candidate",
  "workorders",
  "render-quick",
  "review-ready",
  "viewer-status",
]);

/**
 * Operations reserved for the human/operator authority. In trusted mode the builder
 * cannot invoke these: run creation with non-default policy, policy migration/rebind,
 * human visual approval, viewer start approval, and trusted finalization.
 */
export const HUMAN_ADMIN_OPERATIONS = new Set([
  "create-run",
  "create-workspace-run",
  "approve-policy",
  "migrate-rebase",
  "record-human-approval",
  "approve-review",
  "approve-viewer-start",
  "viewer-start",
  "trusted-finalize",
  "certify",
]);

/** Development-only interfaces kept for tests/debugging; they never touch a trusted run. */
export const DEVELOPMENT_ONLY_OPERATIONS = new Set([
  "bind-oracle",
  "bind-candidate",
  "bind-config",
  "record-evidence",
  "attempt",
  "prepare-review-raw",
  "record-review-raw-verdict",
  "gate-raw",
  "render-raw",
  "finalize-bare-state",
]);

export type OperationName = string;

export function classifyOperation(operation: OperationName): Capability | "development-only" | "unknown" {
  if (HUMAN_ADMIN_OPERATIONS.has(operation)) return "human-admin";
  if (BUILDER_OPERATIONS.has(operation)) return "builder";
  if (DEVELOPMENT_ONLY_OPERATIONS.has(operation)) return "development-only";
  return "unknown";
}

export class CapabilityError extends Error {
  constructor(operation: OperationName, required: Capability) {
    super(`operation ${operation} requires ${required} capability and is not available to the reconstruction builder`);
    this.name = "CapabilityError";
  }
}

export function assertCapability(operation: OperationName, capability: Capability): void {
  const required = classifyOperation(operation);
  if (required === "builder") return;
  if (required === capability) return;
  if (required === "human-admin") throw new CapabilityError(operation, "human-admin");
  if (required === "development-only") throw new Error(`operation ${operation} is development-only and cannot mutate a trusted run`);
  throw new Error(`unknown operation: ${operation}`);
}

/**
 * v1 limitation (final closure §11): one trusted broker instance is assumed to serve one
 * builder authority domain. The broker-wide builder token can discover and operate on every
 * run. Run-scoped capability binding (token.runId must equal request.runId) is deferred to a
 * future release. Until then, deployments that need multi-agent isolation must run separate
 * broker instances with separate stores.
 */

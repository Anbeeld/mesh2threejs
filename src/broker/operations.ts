/**
 * Canonical broker operation registry (remaining closure §7.4). The server's advertised
 * routes, the typed client methods, capabilities.BUILDER_OPERATIONS/HUMAN_ADMIN_OPERATIONS,
 * and the docs command list are all validated against THIS single table — no parallel sets
 * may drift apart.
 */
export interface BrokerOperationDescriptor {
  name: string;
  capability: "builder" | "human-admin";
  /** "implemented" routes exist end to end; "stub" answers 400 by design (admin uses the operation-level route). */
  status: "implemented" | "stub";
}

export const BROKER_OPERATIONS: ReadonlyArray<BrokerOperationDescriptor> = [
  { name: "begin-run", capability: "builder", status: "implemented" },
  { name: "status", capability: "builder", status: "implemented" },
  { name: "next", capability: "builder", status: "implemented" },
  { name: "find-runs", capability: "builder", status: "implemented" },
  { name: "read-run", capability: "builder", status: "implemented" },
  { name: "probe", capability: "builder", status: "implemented" },
  { name: "route", capability: "builder", status: "stub" },
  { name: "onboard-oracle", capability: "builder", status: "implemented" },
  { name: "repair-oracle", capability: "builder", status: "implemented" },
  { name: "register", capability: "builder", status: "implemented" },
  { name: "oracle-sanity", capability: "builder", status: "implemented" },
  { name: "derive", capability: "builder", status: "implemented" },
  { name: "gate", capability: "builder", status: "implemented" },
  { name: "lock", capability: "builder", status: "implemented" },
  { name: "reopen", capability: "builder", status: "implemented" },
  { name: "audit-candidate", capability: "builder", status: "stub" },
  { name: "workorders", capability: "builder", status: "implemented" },
  { name: "render-quick", capability: "builder", status: "implemented" },
  { name: "review-ready", capability: "builder", status: "implemented" },
  { name: "viewer-status", capability: "builder", status: "implemented" },
  { name: "author-status", capability: "builder", status: "implemented" },
  { name: "author-compile", capability: "builder", status: "implemented" },
  { name: "author-check", capability: "builder", status: "implemented" },
  { name: "author-checkpoint", capability: "builder", status: "implemented" },
  { name: "author-measure", capability: "builder", status: "implemented" },
  { name: "author-compare", capability: "builder", status: "implemented" },
  { name: "reference-scene", capability: "builder", status: "implemented" },
  { name: "validate-frozen", capability: "builder", status: "implemented" },
  { name: "freeze-construction", capability: "builder", status: "implemented" },
  { name: "reopen-authoring", capability: "builder", status: "implemented" },
  { name: "create-workspace-run", capability: "human-admin", status: "implemented" },
  { name: "approve-review", capability: "human-admin", status: "implemented" },
  { name: "approve-viewer-start", capability: "human-admin", status: "implemented" },
  { name: "viewer-start", capability: "human-admin", status: "implemented" },
  { name: "trusted-finalize", capability: "human-admin", status: "implemented" },
  { name: "certify", capability: "human-admin", status: "stub" },
  { name: "record-human-approval", capability: "human-admin", status: "stub" },
];

/** Operations the server actually serves for builders (stubs answer 400). */
export const IMPLEMENTED_BUILDER_ROUTES = new Set(BROKER_OPERATIONS.filter((op) => op.capability === "builder" && op.status === "implemented").map((op) => op.name));

/** Admin operations the server recognizes; stubs answer 400 even for admins. */
export const RECOGNIZED_ADMIN_ROUTES = new Set(BROKER_OPERATIONS.filter((op) => op.capability === "human-admin").map((op) => op.name));

export const IMPLEMENTED_ADMIN_OPERATIONS = new Set(BROKER_OPERATIONS.filter((op) => op.capability === "human-admin" && op.status === "implemented").map((op) => op.name));

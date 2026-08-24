# Host status

The Codex, Claude Code, and OpenCode adapters are configuration surfaces only. Their manifests do not prove instruction discovery, permissions, resumption, image inspection, or end-to-end behavior.

## Development vs trusted reconstruction

This repository ships two runtime classes with different authority:

- **Development (default).** `node dist/cli.js` is a builder-invocable surface. It can gate,
  derive, render, and record evidence for an unbound workspace, but it can never certify:
  `finalize` refuses with `TRUSTED_CERTIFICATION_UNAVAILABLE` (exit 6) or fails certification
  checks with exit 2. A verdict JSON recorded through `record-review` is
  **automated-visual-diagnostic** data only.
- **Trusted.** Trusted operations run through the broker tool server (`src/broker/server.ts`)
  launched from the packaged installation outside builder command control. The broker
  verifies toolchain bytes at startup, strips unsafe launch configuration, owns the canonical
  run-authority store outside the workspace, and exposes builder-safe operations only.
  Human visual approval and trusted finalization require the separate admin token delivered
  to the launching user's console — never to the builder model.

A host may advertise `trustedReconstruction: true` only after a trial proves ALL of:

- trusted broker outside builder write authority;
- canonical authority storage outside builder write authority;
- a verified candidate isolation backend (`trusted-isolated`);
- human approval capability separated from builder tools;
- toolchain byte verification on startup.

Until then every adapter declares `trustedReconstruction: false`,
`builderToolIsolation/toolchainWriteIsolation/humanApprovalSeparation: "unverified"`, and
`candidateSandboxBackend: "none"` — fail-closed truth per the plan's §26 promotion criteria.

The durable state exposes the active phase, locks, reopens, attempts, evidence bindings, and visual-review status. Actual host trials are deferred and listed in [DEFERRED-VERIFICATION.md](DEFERRED-VERIFICATION.md).

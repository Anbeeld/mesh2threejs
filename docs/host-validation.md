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

## Installed lifecycle evidence

The `test:installed-lifecycle` validation proves the COMPLETE trusted certification path
end-to-end from a clean `npm pack` → `npm install <tgz>` → installed broker → trusted
create-workspace-run → onboard/register/derive/gate/lock → review-ready → human/admin
approve-review → trusted-finalize → certified. This verifies the BROKER operation chain,
toolchain byte verification, and certification logic. It does NOT verify host permission
isolation (builder cannot write toolchain/store/admin) — that requires a real host trial
with OS-level permission boundaries.

## Host trial procedure

Before promoting an adapter from `unverified`, perform the following trial on the actual
target host and record the results here:

```
host/version
OS
launch procedure
toolchain install path
broker store path
builder permission boundary
admin capability path
attack checks
results
```

### Builder attack checks

From the actual builder command environment, attempt:

1. Write installed runtime file (e.g. `dist/core/oracle.js`) — expected: refused
2. Write profile contract (e.g. `profiles/tank/contract.json`) — expected: refused
3. Write authority record (e.g. store directory) — expected: refused
4. Write private execution staging root (e.g. storeRoot/runtime/executions/) — expected: refused
5. Read admin token/channel — expected: unavailable

### Builder positive checks

1. Edit workspace `model/repairs/*.json` — expected: succeeds
2. Read builder connection descriptor — expected: succeeds
3. Invoke builder-safe broker operations — expected: succeeds

### Admin separation checks

Builder must NOT possess: `adminToken`, `approve-review`, `approve-viewer-start`,
`trusted-finalize`. The human/operator channel must be separate.

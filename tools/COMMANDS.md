# Tool surface

Trusted reconstruction authority surface = broker. Development mutation surface = CLI.

The compiled `mesh2threejs` CLI initializes workspaces, reports status/next action, probes/onboards/repairs references, binds geometry hashes, runs gates, records artifacts, locks/reopens phases, records attempts, inspects drift, and finalizes from artifact files — but only on **unbound development workspaces**. A workspace whose state carries `mirrorOfRun` is bound to a trusted run: every mutating operation goes through the broker operation API instead, and raw CLI mutations are refused there.

Library APIs expose deterministic and actual-Three.js rendering, boards, turntables, review packets, workorder grouping, pose evaluation, and cache identities. Run `node dist/cli.js help` for exact CLI syntax.

## Capability partition

Low-level mutation commands (`bind-oracle`, `bind-candidate`, `bind-config`,
`record-evidence`, `attempt`, raw `gate`/`render`/`finalize` against bare state files) are
DEVELOPMENT-ONLY. They refuse any workspace bound to a trusted run
(`state.mirrorOfRun`), and they can never certify. Trusted finalization, human visual
approval, viewer start approval, and non-default policy creation are human/admin
operations executed by the trusted broker (`src/broker/server.ts`), which verifies
toolchain bytes and owns the canonical authority record outside the workspace.
### Trusted broker operations

For a workspace bound to a trusted run, use the broker operation API (never low-level CLI
mutations): `begin-run`, `onboard-oracle`, `repair-oracle`, `register`, `oracle-sanity`,
`derive`, `gate`, `lock`, `reopen`, `review-ready`, and — through the human/admin channel
only — `approve-review`, `approve-viewer-start`, `viewer-start`, `trusted-finalize`.
Geometry repair is declarative data: write `model/repairs/<phase>.json` against
`schemas/derived-repair.v1.json`; derive validates and compiles it. Executable repair
modules are refused in trusted derived runs. A gate failure means repair geometry or
diagnose the oracle/semantic mapping; it never authorizes weakening the gate.
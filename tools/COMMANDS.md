# Tool surface

The compiled `mesh2threejs` CLI is the authoritative mutation surface. It initializes workspaces; reports status/next action; probes, onboards, and repairs references; binds geometry hashes; performs transitive candidate audits; runs gates; records verified artifacts; locks and reopens phases; records attempts; inspects upstream drift; and finalizes from artifact files.

Library APIs expose deterministic and actual-Three.js rendering, boards, turntables, review packets, workorder grouping, pose evaluation, and cache identities. Run `node dist/cli.js help` for exact CLI syntax.

## Capability partition

Low-level mutation commands (`bind-oracle`, `bind-candidate`, `bind-config`,
`record-evidence`, `attempt`, raw `gate`/`render`/`finalize` against bare state files) are
DEVELOPMENT-ONLY. They refuse any workspace bound to a trusted run
(`state.mirrorOfRun`), and they can never certify. Trusted finalization, human visual
approval, viewer start approval, and non-default policy creation are human/admin
operations executed by the trusted broker (`src/broker/server.ts`), which verifies
toolchain bytes and owns the canonical authority record outside the workspace.
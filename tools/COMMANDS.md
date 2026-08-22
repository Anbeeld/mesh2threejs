# Tool surface

The compiled `mesh2threejs` CLI is the authoritative mutation surface. It initializes workspaces; reports status/next action; probes, onboards, and repairs references; binds geometry hashes; performs transitive candidate audits; runs gates; records verified artifacts; locks and reopens phases; records attempts; inspects upstream drift; and finalizes from artifact files.

Library APIs expose deterministic and actual-Three.js rendering, boards, turntables, review packets, workorder grouping, pose evaluation, and cache identities. Run `node dist/cli.js help` for exact CLI syntax.

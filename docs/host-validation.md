# Host adapter validation

Validation environment: Windows, 2026-08-22.

| Host | Discovery/launch evidence | Commands/tools | Fresh critic | Certification status |
|---|---|---|---|---|
| Codex Desktop | This repository was implemented in a project-local task; root `AGENTS.md` and skills are present. Windows app alias was found but direct `codex --version` returned access denied. | Shell, filesystem, Node build/test/browser-capable host | Proven via separate Node worker process | Supported in the current desktop environment; CLI-alias launch not claimed |
| Claude Code | Executable not installed | Host-neutral CLI/config supplied only | Node worker available if the host can execute it | Configuration-only, not certified on this machine |
| OpenCode | Executable not installed | Host-neutral CLI/config supplied only | Node worker available if the host can execute it | Configuration-only, not certified on this machine |

All hosts use `npm run build` and `node dist/cli.js`; task state is surfaced through workspace `task.json`/`state.json`. The separate-process critic provides state/context isolation from the builder, but its deterministic implementation is not represented as a second model. A host vision agent may add calibrated `visualFindings` to the signed packet without gaining edit authority.

The adapter manifests are regression-tested for honest capability flags. Actual Claude/OpenCode instruction discovery or subagent behavior remains deliberately unclaimed until those executables are installed and exercised.

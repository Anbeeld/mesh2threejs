# Host compatibility

Plain documentation of what each agent host needs to run the mesh2threejs workflow, and
what has actually been exercised. This is a setup and integration reference — not a
certification claim. Authority in this repository comes from instruction surfaces
(`AGENTS.md`, `SKILL.md`, `skills/**`) that hosts genuinely consume, plus the trusted
pipeline's own validators; no host-specific executable configuration exists beyond the
harness files themselves (for example `agents/openai.yaml`, which Codex consumes).

Verification vocabulary:

- **verified**: exercised end-to-end on a real workspace with captured evidence.
- **unverified**: expected to work from the host's documented capabilities; not yet exercised here.
- Update this file after each real host trial; do not maintain machine-read capability flags.

## Codex Desktop

| Capability | State |
| --- | --- |
| Instruction discovery (`AGENTS.md`) | unverified |
| Skill discovery (`SKILL.md`, `skills/`) | unverified |
| Command execution (`npm`, `node dist/cli.js`) | unverified |
| Image inspection for visual review | unverified |
| Durable session resumption across runs | unverified |

Setup notes: open the repository as a task, invoke the root skill (`$mesh2threejs`),
and hydrate workspace state before mutating operations. Development-mode behavior uses
`npm run build` and `node dist/cli.js`. Treat project discovery, browser rendering, and
image review as unverified until a fresh captured host trial passes.

## Claude Code

| Capability | State |
| --- | --- |
| Instruction discovery (`AGENTS.md`) | unverified (host not installed in validation environment) |
| Skill discovery (`SKILL.md`, `skills/`) | unverified |
| Command execution (`npm`, `node dist/cli.js`) | unverified |
| Image inspection for visual review | unverified |
| Durable session resumption across runs | unverified |

Setup notes: start Claude Code in the repository and explicitly ask it to read
`AGENTS.md` and `SKILL.md` before selecting a role skill. Verify instruction/skill
discovery, executable profile loading, command/browser access, durable resumption, and
genuine image review during the first real trial.

## OpenCode

| Capability | State |
| --- | --- |
| Instruction discovery (`AGENTS.md`) | verified |
| Skill discovery (`SKILL.md`, `skills/`) | verified |
| Command execution (`npm`, broker tool server) | verified |
| Image inspection for visual review | unverified |
| Durable session resumption across runs | verified |

Setup notes: OpenCode reads `AGENTS.md` automatically and loads role skills through the
standard skill mechanism. Trusted operations run through the `mesh2threejs-broker`
tool server launched from the packaged installation; raw CLI mutations are refused on
managed runs. The interactive viewer is available for non-authoritative inspection.

## Host trial expectations

A host trial is complete when it produces captured evidence of: instruction and skill
discovery, an onboarded oracle through trusted intake, at least one locked builder
phase, deterministic gate evidence, and a genuine human visual review with image
inspection performed by a person. Record the outcome and date in the table above.

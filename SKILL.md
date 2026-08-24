---
name: mesh2threejs
description: Reconstruct rigid hard-surface GLB references as procedural Three.js via derived-seed or clean-room strategy, with executable profile contracts, deterministic gates, durable phase locks, and genuine visual review. Use for tank or generic tasks in this repository.
metadata:
  version: '1.0.0'
  prompting-standard: 'PROMPTING.md v1.1.0'
---

# Mesh2Threejs Router

Hydrate `project.json` and `.mesh2threejs/state.json` before acting. Never rely on chat memory when durable state exists.

Non-negotiable invariants:

- Keep workspace files inside their workspace (scratch under `.mesh2threejs/tmp/`).
- Candidate never loads `refs/oracle/*` or `.mesh2threejs/oracle/*` at runtime.
- Derived mode (default): trusted tools may derive `model/.generated/` from the prepared oracle, bound by `.mesh2threejs/derived/` manifests. Repair is declarative data only (`model/repairs/<active-phase>.json` per `schemas/derived-repair.v1.json`, compiled by rerunning derive); executable repair modules are refused.
- Independent mode: measure but never reuse source topology; author procedurally.
- Hand-authored modules never carry dense payloads; only verified generated modules may.
- Keep source oracle bytes immutable; only onboarding/repair writes prepared state.
- Preserve macro geometry, orientation, semantics, articulation, and repeated counts; low-poly may simplify, never distort truth.
- Automated/model visual assessment is diagnostic data only; HUMAN approval through the trusted run authority is the final visual authority.

Mode resolution comes FIRST: a workspace whose state carries `mirrorOfRun` is bound to a trusted run — every operation goes through the broker operation API (`probe`, `onboard-oracle`, `register`, `oracle-sanity`, `derive`, `gate`, `lock`, `reopen`, `workorders`, `render-quick`, `review-ready`); raw CLI mutations are refused there, and policy drift requires an administrative rebase/new run, never `rebind`. Unbound workspaces use the development CLI.

When ready for inspection on a trusted run: broker `review-ready` computes the capture set itself and reports exact paths; report them, then ask — the viewer starts only after explicit human/admin `approve-viewer-start`. The viewer never satisfies `visual.review`, gates, or certification.

Route with `mesh2threejs route <task>` only for unbound development tasks; a trusted run is already routed by intake — read canonical status/next/profile from the broker. Load exactly one role skill from `skills/`: `reconstruct`, `onboard-oracle`, `repair-oracle`, `build`, `visual-review`, `diagnose`, or `finalize`. Select `profiles/tank/` only for explicit or unmistakable tanks/tracked armored vehicles; otherwise use `profiles/generic/`.

Completion means trusted certification succeeds for the exact final hashes; trusted finalize runs a fresh global replay first, so anything changed since human approval requires re-review. Development runs never claim certification.

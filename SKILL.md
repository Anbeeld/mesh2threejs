---
name: mesh2threejs
description: Reconstruct rigid hard-surface live GLB oracles as independently authored procedural Three.js, with deterministic geometry/style gates, durable evidence, and an independent critic. Use for tank or generic live-oracle reconstruction tasks in this repository.
---

# Mesh2Threejs Router

Hydrate `task.json` and `state.json` before acting. Never rely on chat memory when durable state exists.

Non-negotiable invariants:

- Treat the admitted live source/prepared oracle as geometry truth; never embed it in the candidate.
- Keep source oracle bytes immutable. Only onboarding/repair may write prepared-oracle state.
- Produce native procedural Three.js source and bind every gate result to oracle/candidate hashes.
- Preserve macro geometry, orientation, semantics, articulation, and repeated-part counts. Low-poly style may simplify representation, never truth.
- A critic cannot edit. Certification requires a fresh separate-process critic and all evidence in `src/core/state.ts`.

Route with `mesh2threejs route <task>` and load exactly one role skill from `skills/`: `reconstruct`, `onboard-oracle`, `repair-oracle`, `build`, `critic`, `diagnose`, or `finalize`.

Select `profiles/tank/` only for explicit or unmistakable tanks/tracked armored vehicles; otherwise use `profiles/generic/`. Load `styles/low-poly-faithful.json` unless the task manifest names another validated contract.

Completion means `mesh2threejs finalize <workspace/state.json>` succeeds for the exact final hashes and the handoff includes source, reports, board, turntable, provenance, and intentional simplifications.

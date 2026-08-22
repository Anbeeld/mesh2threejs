---
name: mesh2threejs
description: Reconstruct rigid hard-surface live GLB references as independently authored procedural Three.js, with executable profile contracts, deterministic gates, durable phase locks, and genuine visual review. Use for tank or generic reconstruction tasks in this repository.
metadata:
  version: '0.4.0'
  prompting-standard: 'PROMPTING.md v1.1.0'
---

# Mesh2Threejs Router

Hydrate `project.json` and `.mesh2threejs/state.json` before acting. Never rely on chat memory when durable state exists.

Non-negotiable invariants:

- Treat the admitted live source/prepared oracle as geometry truth; never embed it in the candidate.
- Keep source oracle bytes immutable. Only onboarding/repair may write prepared-oracle state.
- Produce native procedural Three.js source and bind every gate result to oracle/candidate hashes.
- Preserve macro geometry, orientation, semantics, articulation, and repeated-part counts. Low-poly style may simplify representation, never truth.
- A visual reviewer cannot edit. Certification requires a fresh external-vision verdict and verified artifact files; process isolation alone is insufficient.

Route with `mesh2threejs route <task>` and load exactly one role skill from `skills/`: `reconstruct`, `onboard-oracle`, `repair-oracle`, `build`, `visual-review`, `diagnose`, or `finalize`.

Select `profiles/tank/` only for explicit or unmistakable tanks/tracked armored vehicles; otherwise use `profiles/generic/`. Load that profile's executable `contract.json` and `styles/low-poly-faithful.json` unless the task names another validated style.

Completion means `mesh2threejs finalize <workspace>` succeeds for the exact final hashes and the handoff includes source, reports, board, turntable, provenance, and intentional simplifications.

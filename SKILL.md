---
name: mesh2threejs
description: Reconstruct rigid hard-surface live GLB references as independently authored procedural Three.js, with executable profile contracts, deterministic gates, durable phase locks, and genuine visual review. Use for tank or generic reconstruction tasks in this repository.
metadata:
  version: '1.0.0'
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

When current work is ready for the user to inspect, refresh the full model capture first (`mesh2threejs review-ready <workspace>`, or `render`) and report its paths; then offer the interactive viewer. Never start the persistent viewer server without explicit user approval. Viewer inspection and user feedback are non-authoritative: they route back into existing reconstruction phases via the normal reopen/repair lifecycle and never satisfy `visual.review`, gates, or certification.

Route with `mesh2threejs route <task>` and load exactly one role skill from `skills/`: `reconstruct`, `onboard-oracle`, `repair-oracle`, `build`, `visual-review`, `diagnose`, or `finalize`.

Select `profiles/tank/` only for explicit or unmistakable tanks/tracked armored vehicles; otherwise use `profiles/generic/`. Load that profile's executable `contract.json` and `styles/low-poly-faithful.json` unless the task names another validated style.

Completion means `mesh2threejs finalize <workspace>` succeeds for the exact final hashes and the handoff includes source, reports, board, turntable, provenance, and intentional simplifications.

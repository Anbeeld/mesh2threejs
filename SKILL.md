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

- Keep every workspace-related file inside its workspace (scratch under `.mesh2threejs/tmp/`); never write to repo root or other workspaces.
- Candidate never loads `refs/oracle/*` or `.mesh2threejs/oracle/*` at runtime.
- Derived mode (default for new 3D-oracle workspaces): trusted tools may derive `model/.generated/` from the prepared oracle at build time, bound by `.mesh2threejs/derived/` manifests.
- Independent mode: measure but never reuse source topology; author procedurally.
- Hand-authored modules never carry dense payloads; only verified generated modules may.
- Keep source oracle bytes immutable; only onboarding/repair writes prepared state.
- Produce native procedural Three.js and bind every gate to oracle/candidate hashes.
- Preserve macro geometry, orientation, semantics, articulation, and repeated counts; low-poly may simplify, never distort truth.
- Visual reviewer cannot edit; certification needs fresh external-vision verdict and verified artifacts.

When ready for inspection, refresh full capture (`mesh2threejs review-ready <workspace>` or `render`) and report paths; then offer viewer. Never start viewer without approval. Viewer is non-authoritative and never satisfies `visual.review`, gates, or certification.

Route with `mesh2threejs route <task>` and load exactly one role skill from `skills/`: `reconstruct`, `onboard-oracle`, `repair-oracle`, `build`, `visual-review`, `diagnose`, or `finalize`.

Select `profiles/tank/` only for explicit or unmistakable tanks/tracked armored vehicles; otherwise use `profiles/generic/`. Load that profile's executable `contract.json` and `styles/low-poly-faithful.json` unless the task names another validated style.

Completion means `mesh2threejs finalize <workspace>` succeeds for the exact final hashes and the handoff includes source, reports, board, turntable, provenance, and intentional simplifications.

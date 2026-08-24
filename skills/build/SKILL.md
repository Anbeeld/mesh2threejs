---
name: build
description: Author or repair native procedural Three.js from actionable oracle-relative workorders. Use after registration and whenever deterministic or style evidence fails.
---

# Build Procedural Candidate

Read the selected profile standard and StyleContract. Execute one coherent repair group: one component/relationship and its necessary dependent fixes.

Mode resolution first: a workspace whose state carries `mirrorOfRun` is bound to a trusted run — all operations go through the broker. Otherwise use the development CLI.

Authorship strategy first: check `state.authorshipMode`. In **derived** mode, when the active phase has no usable geometry, run broker `derive` before authoring anything by hand: inspect/gate the seed, then make one coherent declarative repair: write model/repairs/<active-phase>.json against schemas/derived-repair.v1.json (component transform, simplify override, keep/drop, hierarchy parent, primitive replace, mesh replace within ceiling, material) and rerun broker `derive`; executable .mjs repair modules are refused. Do not build the main hull/turret from scratch before trying derivation. In **independent** mode, use native Three.js primitives, lofts, transforms, materials, semantic IDs, and explicit pivots. Tank canonical frame is +X right, +Y up, +Z forward, ground at min Y, neutral gun +Z. Tank candidates expose `setPose({turretYaw, gunElevation})`; fittings must live under the pivot that owns them. Never load oracle files at runtime. Hand-authored modules must never carry dense topology or opaque hex/base64 payloads; only pipeline-generated `model/.generated/` modules may, and only while their derivation manifests stay bound to the current preparation. Small explicit low-poly control cages (10-30 hull points, ~300-500 numeric values) are preferred over stacks of generic primitives when oracle has clear planar/contour structure. Preserve macro truth before detail. Keep every scratch artifact inside the workspace: temporary probe/variant scripts, diagnostic renders, and ad-hoc fixtures belong under `<workspace>/.mesh2threejs/tmp/`, never in the repository root or shared folders. Run the transitive candidate audit and profile/style gates via broker `gate`; work only on the active phase — do not optimize pending phases even if global diagnostics exist. If an active macro gate is below structural threshold (<80), change representation rather than sweeping dimensions on a primitive that visibly cannot match.

Trusted build loop: broker `derive` → broker `gate` → broker `workorders` if failed → edit `model/repairs/<phase>.json` → broker `derive` → broker `gate` → broker `render-quick` when useful → broker `lock`.

For a first build in an active phase, finish the smallest complete candidate for that phase before running its audit-and-repair cycle. Do not interleave evaluator verdicts into construction of one incomplete component. After the first derived seed or any representation-level repair, inspect a quick phase render (broker `render-quick`) yourself when host image inspection is available; if the macro read is grossly wrong, change representation/derive recipe instead of entering numeric iteration. These captures are builder diagnostics only — they never satisfy visual review.

Candidate changes invalidate dependent evidence. If three equivalent attempts add no evidence and do not move a metric, route to diagnosis; failed gates are recorded automatically, so no manual attempt bookkeeping is needed.

Handoff to the user happens at final review by default: continue autonomously through builder phases; once all pre-review phases pass, run broker `review-ready`, report the fresh capture directory, comparison boards, and turntable, then ask whether to launch the interactive viewer and wait for the user's visual verification. Intermediate handoffs happen only when the user explicitly asks to see progress. Never start the viewer without explicit user approval.

## DEVELOPMENT MODE

On an unbound development workspace (no `mirrorOfRun`), the CLI may be used directly: `mesh2threejs derive`, `mesh2threejs gate`, `mesh2threejs render --phase active --quick`, `mesh2threejs review-ready`. These never certify.

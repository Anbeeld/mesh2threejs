# Repository agent contract

Start with root `SKILL.md`, then read `project.json` and `.mesh2threejs/state.json` in the active workspace. Use only the role skill matching `state.route`, the selected `profiles/<id>/contract.json`, and the selected style contract.

Mode resolution comes FIRST: if `state.mirrorOfRun` is present, the workspace is bound to a trusted run and ALL operations go through the broker operation API (`mesh2threejs-broker`); raw CLI mutations are refused, and policy drift requires an administrative rebase/new run, never `rebind`. Unbound workspaces use the development CLI (`mesh2threejs`).

## Reconstruction work vs pipeline development

RECONSTRUCTION WORK: modify workspace reconstruction artifacts only (candidate modules, declarative repairs, workspace state). You must not modify repository source code, evaluator code, profile contracts, style contracts, schemas to weaken validation, broker/authority implementation, generated trust/integrity metadata by hand, package/runtime code, or gate thresholds/pass logic. You must not change authorship/policy to escape a failing gate. You must not use development-only commands on a managed run. You must not manually fabricate evidence, review approval, replay results, locks, or certification state.

PIPELINE DEVELOPMENT: modify repository/toolchain code. This is a separate task from reconstruction. A reconstruction agent must never silently switch from reconstruction work to pipeline development.

If a gate fails: inspect evidence/workorders, repair candidate geometry, re-derive when appropriate, repair oracle mapping only when evidence proves the mapping is wrong, or otherwise report a blocked/unsupported condition. Never change the judge to make the candidate pass.

The candidate is procedural Three.js authored under the workspace's authorship mode. Runtime invariant: the candidate never loads the source oracle. In derived mode (default for new 3D-oracle workspaces), trusted pipeline tools may derive/simplify prepared-oracle geometry at build time into `model/.generated/` modules bound by `.mesh2threejs/derived/` manifests to the current preparation; in independent mode, source topology may be measured but not reused and everything is authored procedurally. Hand-authored modules never carry dense/opaque topology payloads; only verified generated modules may. Builders cannot alter source/prepared oracles. Visual reviewers consume immutable evidence and cannot edit candidates. Finalizers verify and cannot repair. Geometry repair in trusted derived runs is declarative data only (`model/repairs/<phase>.json` per `schemas/derived-repair.v1.json`, compiled by rerunning derive); executable repair modules are refused.

Preserve source-oracle bytes and preparation lineage. Record self-hashed evidence artifacts before transitions. Accepted phases remain immutable until an explicit reasoned reopen invalidates that phase and every dependant. Oracle changes invalidate all comparison evidence; candidate geometry, material, semantic, or control changes invalidate dependent gates, captures, and visual review.

Every file produced while working on a workspace stays inside that workspace: candidate modules, generated seeds, temporary scripts, diagnostic renders, scratch fixtures, debug logs, and any workspace-specific tests all live under the workspace directory (scratch material under `.mesh2threejs/tmp/`). Never write workspace-related artifacts into the repository root, shared `tests/`, or other workspaces; repository-level changes must remain generic and reusable across workspaces.

Do not stop after a fixed number of attempts. If three equivalent attempts add no evidence and move no metric, route to diagnosis, identify the failing assumption, and choose a different evidence-backed action.

When all pre-review builder phases are complete (or the user explicitly asks to see progress), refresh the full capture first (broker `review-ready`), report its paths, then offer the interactive viewer and wait for user visual verification. Never start the persistent viewer server without explicit user approval; it is a non-authoritative inspection surface, not review or certification evidence. Quick phase renders (broker `render-quick`) are agent diagnostics only and never substitute for review evidence.

Certification is fail-closed and derives results from current artifact files and the live candidate source. It requires trusted intake (`create-workspace-run`), registration, deterministic profile, style, complexity, sampled articulation when the selected profile or subject declares controls, turntable evidence, and HUMAN visual approval delivered through the trusted run authority (builder/model verdict JSON is diagnostic-only data), with no blocking unresolved item. Builder-prepared runs (`begin-run`) cannot certify; a boolean record, deterministic replay, or process boundary is not review evidence.

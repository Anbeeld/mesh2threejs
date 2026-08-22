# Implementation handoff

## Baseline and scope

The repository now uses executable profile contracts, durable phase authority, physical measurement evidence, external visual-review authority, and artifact-derived finalization.

## Findings and mechanisms

- Split profile declarations could drift from code. `profiles/*/contract.json` is now the sole contract; `contracts.ts` validates operators, phases, ownership, dependencies, gates, semantics, views, dimensions, repeats, controls, style permissions, and completion.
- Accepted geometry could change silently. `state.ts` stores phase locks and reasoned reopens, refuses candidate/reference changes behind locks, and invalidates all dependants.
- Evidence trusted booleans. Evidence artifacts now contain generator/schema/config/profile/geometry bindings, their result, and a content hash. Finalization re-reads every file.
- Camera scale and workorders were coarse. Reference-derived physical framing chooses resolution from requested object-unit precision; curve/station rows retain registration, mean, P95, coverage, samples, worst locations, and physical deviations.
- Tank checks hid local errors. Turret seating is three-axis; authoritative hull length is consumed; running gear compares each role/side/order instance; tracks require a course void and physical envelope; physical orientation ignores metadata; fabrication includes closure and disconnected-island checks.
- Articulation helpers were disconnected from production. Candidate runtimes expose `setPose`; gate evaluation samples negative/large yaw, depression, elevation, and combined poses while checking moving/stationary ownership.
- Deterministic replay was mislabeled as review. Immutable visual packets and external-vision verdicts are separate; unavailable vision leaves an explicit waiting state.
- Rendering did not prove Three.js material/light behavior. The CPU diagnostic path remains deterministic and a separate `WebGLRenderer` six-pass path accepts browser/headless surfaces.
- Candidate and reference boundaries were narrow. Candidate audits follow local imports and reject dense payloads; GLB world bounds honor transforms; stable node identities resolve duplicate names; normalized/sparse accessors are decoded and required unsupported compression fails closed.
- CLI progress depended on conversational context. Status, next action, bind, record-evidence, lock, reopen, attempt, drift, and artifact-derived finalize operations persist atomically.
- Workspace behavior depended on the current directory and split user configuration from runtime files poorly. `project.json`, `refs/`, and `model/` now form the stable surface; `.mesh2threejs/` owns state and generated artifacts. A single resolver handles copied, external, relocated, and migrated references with recorded hashes and provenance.

## Source synthesis

Exact credits and pins remain in [upstream-map.md](upstream-map.md). Claude-of-Tanks has newer suspension and track-audit changes; inspection found fleet/gameplay linkage receipts and axle-gap checks rather than changes to the adapted measurement formulas, so nothing was auto-merged. The img2threejs and PROMPTING.md pins still match their remote heads as of 2026-08-22.

## Development checks

Run `npm run validate` for types, protected regression coverage, build, and artifact validation. Run `npm run test:e2e` and `npm run benchmark` only as analytical smoke/performance checks. A dry-run package inspection should confirm the distributable surface.

## Remaining evidence

Large real references, the flagship reconstruction, non-tank agent flow, actual browser/headless WebGL captures, calibrated external visual review, and fresh Codex/Claude Code/OpenCode trials have not been claimed. [DEFERRED-VERIFICATION.md](DEFERRED-VERIFICATION.md) defines the exact campaign and production-claim gate.

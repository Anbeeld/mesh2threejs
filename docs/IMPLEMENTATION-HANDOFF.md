# Implementation handoff

## Baseline and scope

The repository now uses executable profile contracts, durable phase authority, physical measurement evidence, external visual-review authority, and artifact-derived finalization.

## Findings and mechanisms

- Split profile declarations could drift from code. `profiles/*/contract.json` is now the sole contract; `contracts.ts` validates operators, phases, ownership, dependencies, gates, semantics, views, dimensions, repeats, controls, style permissions, and completion.
- Accepted geometry could change silently. `state.ts` stores phase locks and reasoned reopens, refuses candidate/reference changes behind locks, and invalidates all dependants.
- Evidence trusted booleans. Declared artifacts are now distinct from runtime evaluation, runtime render/capture, oracle-registration, and external-review evidence. Routing and certification accept only the authority appropriate to each evidence kind. A phase lock checks exact required gate codes, thresholds, profile contract, geometry bindings, and its create-only artifact file.
- Camera scale and workorders were coarse. Reference-derived physical framing chooses resolution from requested object-unit precision; curve/station rows retain registration, mean, P95, coverage, samples, worst locations, and physical deviations.
- Tank checks hid local errors. Turret seating is three-axis; authoritative hull, body, and overall dimensions use explicit semantic policies; running gear compares each role/side/order instance; tracks check lower and upper runs, curved wraps, endpoint clearances, continuity, and three-dimensional hull penetration; physical orientation ignores metadata; fabrication includes closure and disconnected-island checks.
- Articulation helpers were disconnected from production. Candidate runtimes accept control-ID maps; the evaluator executes the profile or subject contract's samples, expands moving ownership through descendants, treats everything else as stationary, and reruns spatial seating checks at each pose.
- Deterministic replay was mislabeled as review. Visual packets and external-vision verdicts are separate; packet preparation, review recording, and finalization reopen every referenced file, while unavailable vision leaves an explicit waiting state.
- Rendering did not prove Three.js material/light behavior. One backend selector now uses `WebGLRenderer` when a caller supplies a browser/headless surface, reports the CPU fallback under `auto`, and rejects an explicit WebGL request without a surface.
- Candidate and reference boundaries were narrow. Candidate audits follow local imports and reject dense payloads; GLB world bounds honor transforms; stable node identities resolve duplicate names; normalized/sparse accessors are decoded and required unsupported compression fails closed.
- CLI progress depended on conversational context. Gate and render runs use create-only numbered directories; workspace commands derive active-phase workorders and lock inputs, record turntable evidence, assemble review packets, and finalize from reopened artifacts. A file-stamp cache reuses unchanged gate evaluations without adding another hash-derived naming scheme.
- Large snapshots amplified memory through per-triangle objects and copied filtered scenes. Geometry now uses typed structure-of-arrays storage, filtered views share those buffers, fingerprints stream over the compact data, and the benchmark snapshots, fingerprints, and captures a 3.5-million-triangle synthetic scene.
- Workspace behavior depended on the current directory and split user configuration from runtime files poorly. `project.json`, `refs/`, and `model/` now form the stable surface; `.mesh2threejs/` owns state and generated artifacts. A single resolver handles copied, external, relocated, and migrated references with recorded hashes and provenance.

## Source synthesis

Exact credits and pins remain in [upstream-map.md](upstream-map.md). Claude-of-Tanks has newer suspension and track-audit changes; inspection found fleet/gameplay linkage receipts and axle-gap checks rather than changes to the adapted measurement formulas, so nothing was auto-merged. The img2threejs and PROMPTING.md pins still match their remote heads as of 2026-08-22.

## Development checks

Run `npm run validate` for types, protected regression coverage, build, and artifact validation. Run `npm run test:e2e` and `npm run benchmark` only as analytical smoke/performance checks. A dry-run package inspection should confirm the distributable surface.

## Remaining evidence

Large real references, the flagship reconstruction, non-tank agent flow, actual browser/headless WebGL captures, calibrated external visual review, and fresh Codex/Claude Code/OpenCode trials have not been claimed. [DEFERRED-VERIFICATION.md](DEFERRED-VERIFICATION.md) defines the exact campaign and production-claim gate.

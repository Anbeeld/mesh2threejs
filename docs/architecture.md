# Architecture

The pipeline separates reference truth, candidate construction, deterministic measurement, visual judgment, and durable authority.

Each project has one workspace root. `project.json` contains stable user-facing configuration, `refs/` contains copied source material, and `model/` contains authored Three.js code. Runtime state and generated artifacts are isolated under `.mesh2threejs/`: reference provenance in `references.json`, lifecycle state in `state.json`, oracle recipes in `oracle/`, and generated evidence, reports, captures, visual-review packets, and locks in their named directories. Commands resolve project paths from this root, so copied workspaces remain valid after relocation. External-reference mode is explicitly non-portable and verifies absolute source paths against their recorded hashes on resume.

```text
immutable GLB -> prepared lineage -> frozen physical frame -> deterministic gates
procedural module -> transitive audit -> native scene + pose controls -> workorders
                                                      | matched six-pass evidence
                                                      v
                                            external visual reviewer
                                                      |
                                    verified artifacts -> finalizer
```

Each profile has one executable `contract.json`; the selected `styles/<id>.json` is likewise the only executable style contract. They declare semantics, operators, phase dependencies and owners, gates, views, dimensions, repeats, articulation samples, style permissions, complexity, and completion evidence. Task lifecycle state is derived from their hashes. Validation rejects unknown operators, missing dependencies, impossible critical semantics, unsupported gates, and runtime evidence that omits a declared threshold or view.

`src/core/oracle.ts` hashes immutable GLB bytes and creates child preparation recipes. World bounds include node transforms; stable `node:N` identities avoid duplicate-name ambiguity. Normalized and sparse accessors are decoded, while unsupported required compression fails closed.

`geometry.ts` snapshots live world transforms and rejects duplicate semantic IDs. `measurement.ts` supplies sections, robust dimensions, landmarks, connectivity, fabrication, attachment, signed-orientation, and pose checks. Tank evaluation freezes a reference-derived camera frame, permits translation-only hull registration, reuses it for whole/turret comparisons, reports all fourteen stations, compares running gear per role/side/order, and checks track-course continuity, upper and lower runs, curved-wrap normal diversity, and 3D AABB hull-envelope occupancy. The last diagnostic is an envelope heuristic, not exact track-to-hull mesh intersection.

`render.ts` is the reproducible CPU diagnostic path. `three-render.ts` exposes one backend-selection entry point and uses Three.js `WebGLRenderer` when a browser or headless WebGL surface is supplied. Without that surface, `auto` selects the CPU path; an explicit `three-webgl` request fails instead of silently changing backends. The Node.js CLI therefore labels its canonical captures as deterministic CPU evidence.

State writes are atomic. A versioned evaluation identity binds evaluator and measurement versions, profile, style, subject contract, certification, the canonical oracle preparation identity (a hash of the complete preparation record: selected reference, source bytes, recipe, semantic and normalization maps, repair lineage, and admitted dimensions), and the transitive candidate source and neutral geometry. Onboarding binds that preparation in state; one shared verifier proves at every authority boundary (register, gate, render, review preparation/recording, lock, finalize, workspace oracle repair) that the manifest, prepared recipe, immutable source bytes, selected project reference, and state binding agree. Oracle repair swaps the binding and invalidates registration and every downstream authority immediately; `rebind` archives the active preparation under `oracle/archive/` so an old preparation can never be silently consumed. Candidate dependency caches use file-content hashes, and each gate loads the candidate by staging the exact audited transitive source graph in a fresh location, so the reported source hash is always the executed code. Candidate-local imports must be static; dynamic local imports are rejected by the audit because they would resolve into the removed staging directory at runtime. Accepted phases store geometry, behavior, contract, dependency, and evidence identities. Candidate changes are refused while affected phases remain locked; `reopen` records a reason and invalidates dependants. Intentional project or contract changes require `rebind`, which starts a new evidence chain. Finalization re-reads the evidence files and rebuilds the live candidate; state booleans are never authority.

Visual review is a separate read-only role. Its packet binds all hashes and immutable captures. When genuine image inspection is unavailable, state remains `awaiting-visual-review`.

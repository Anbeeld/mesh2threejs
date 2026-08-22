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

Each profile has one executable `contract.json`. It declares semantics, operators, phase dependencies and owners, gates, views, dimensions, repeats, articulation samples, style permissions, and completion evidence. Task lifecycle state is derived from it. Validation rejects unknown operators, missing dependencies, impossible critical semantics, unsupported gates, and runtime evidence that omits a declared threshold or view.

`src/core/oracle.ts` hashes immutable GLB bytes and creates child preparation recipes. World bounds include node transforms; stable `node:N` identities avoid duplicate-name ambiguity. Normalized and sparse accessors are decoded, while unsupported required compression fails closed.

`geometry.ts` snapshots live world transforms and rejects duplicate semantic IDs. `measurement.ts` supplies sections, robust dimensions, landmarks, connectivity, fabrication, attachment, signed-orientation, and pose checks. Tank evaluation freezes a reference-derived camera frame, permits translation-only hull registration, reuses it for whole/turret comparisons, reports all fourteen stations, compares running gear per role/side/order, and checks a physical track course rather than its count alone.

`render.ts` is the reproducible CPU diagnostic path. `three-render.ts` uses Three.js `WebGLRenderer` for matched material/light evidence when a browser or headless WebGL surface is supplied. The two paths are labeled separately.

State writes are atomic. Accepted phases store geometry, contract, dependency, and evidence identities. Candidate changes are refused while affected phases remain locked; `reopen` records a reason and invalidates dependants. Evidence artifacts contain their result and content hash. Finalization re-reads the files and derives completion; state booleans are never authority.

Visual review is a separate read-only role. Its packet binds all hashes and immutable captures. When genuine image inspection is unavailable, state remains `awaiting-visual-review`.

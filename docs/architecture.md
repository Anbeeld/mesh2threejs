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

`src/core/oracle.ts` hashes immutable GLB bytes and creates child preparation recipes. World bounds include node transforms; stable `node:N` identities avoid duplicate-name ambiguity. Normalized and sparse accessors are decoded, while unsupported required compression fails closed. A declared `sourceFrame` is validated (distinct unsigned axes, explicit handedness policy that rejects reflections) and converted into one rigid source-to-canonical transform that every prepared-oracle load applies before user normalization, so frame declarations are never passive metadata and survive repair unchanged. A `logicalOwnership` overlay passes a general graph validator (self ownership, cycles, unresolvable targets, forbidden containment such as hull under turret fittings or tracks under gun fittings) and is preserved through repair. Registration proves the physical canonical tank frame — but only for the tank profile: wheel-chain longitudinal spread and lateral separation by executable roles, paired track courses spanning Z separated along X, neutral gun-forward alignment derived from barrel geometry against a real pivot anchor (semantic pivot object or named pivot node, never an articulation-declaring child's origin), and ground contact; a required proof that cannot be evaluated fails registration as manual-map-required instead of being omitted.

`geometry.ts` snapshots live world transforms and rejects duplicate semantic IDs. Semantic parent resolution consumes an explicit logical owner first and falls back to the authored hierarchy, so a flat source with a prepared overlay measures nested without reparenting. `SceneComponent.bounds` carries ONE meaning: the bounds of geometry intrinsically owned by that semantic. A transform-only anchor (group/pivot with zero owned triangles) measures as a zero-volume box at its own world origin — descendant semantics never inflate it — so oracle and candidate pivots compare like with like, and geometryless pivot anchors do not inherit subtree AABBs from articulated descendants. Consumers needing an aggregate over a subtree must build one explicitly instead of overloading this field. `measurement.ts` supplies true triangle-plane section intersection rasterized into even-odd occupancy contours (shape comparison is tessellation independent, and missing contour evidence fails rather than falling back to AABB dimensions), area-weighted principal-plane extraction with offset/centroid/support matching (identifying physical surfaces instead of triangle-normal histograms), projected wheel radial profiles around measured axles, robust dimensions, landmarks, connectivity, fabrication, attachment, signed-orientation, and pose checks. Hull contiguity is a contact-graph connectivity requirement across components plus per-component island checks, so neighboring plates in a connected chain pass while detached clusters fail. Tank evaluation freezes a reference-derived camera frame, permits translation-only hull registration, reuses it for whole/turret comparisons, reports all fourteen stations, compares running gear per role/side/order, and checks track-course continuity, upper and lower runs, curved-wrap normal diversity, and 3D AABB hull-envelope occupancy. The last diagnostic is an envelope heuristic, not exact track-to-hull mesh intersection.

Normal workspace gates execute only the active phase: the evaluator computes and emits solely the rows its contract requires for that phase, articulation controls are exercised only by the phase that owns them (so a plain partial candidate without `setPose` gates during earlier phases), evidence artifacts are written only for evaluated phases, and stdout stays phase-local with no future-phase diagnostics or global style/articulation contents. `--global` remains the explicit complete evaluation and requires those controls.

`render.ts` is the reproducible CPU diagnostic path. `three-render.ts` exposes one backend-selection entry point and uses Three.js `WebGLRenderer` when a browser or headless WebGL surface is supplied. Without that surface, `auto` selects the CPU path; an explicit `three-webgl` request fails instead of silently changing backends. The Node.js CLI therefore labels its canonical captures as deterministic CPU evidence. `workspace-render.ts` runs one full capture run and is shared by `render` and `review-ready`, so user-review handoffs always produce a fresh render run for the live gated candidate; it also produces the first-class oracle-only sanity board (`oracle-sanity`: front/rear/left/right/top/perspective with canonical-frame metadata). Tank registration locking verifies that board against the CURRENT preparation — prepared-hash binding plus re-hashed capture bytes — so a board captured for an earlier preparation can never satisfy a later lock. It is builder/onboarding sanity evidence, not external visual certification.

The optional interactive viewer (`src/viewer/`) is a detached localhost-only process that serves the viewer app, vendored Three.js modules, and exactly the audited candidate source graph — never `refs/`, `.mesh2threejs/`, or any other workspace bytes. Its runtime metadata (`.mesh2threejs/viewer/`) is ephemeral operational state outside the evidence chain, and stop targets the recorded instance through a token-protected shutdown rather than a bare PID. The browser reloads when the candidate source hash changes and drives `setPose` from the profile/subject articulation contract. Viewer use reports nothing to gates or certification.

State writes are atomic. A versioned evaluation identity binds evaluator and measurement versions, profile, style, subject contract, certification, the canonical oracle preparation identity (a hash of the complete preparation record: selected reference, source bytes, recipe, semantic and normalization maps, repair lineage, and admitted dimensions), and the transitive candidate source and neutral geometry. Onboarding binds that preparation in state; one shared verifier proves at every authority boundary (register, gate, render, review preparation/recording, lock, finalize, workspace oracle repair) that the manifest, prepared recipe, immutable source bytes, selected project reference, and state binding agree. Oracle repair swaps the binding and invalidates registration and every downstream authority immediately; `rebind` archives the active preparation under `oracle/archive/` so an old preparation can never be silently consumed. Candidate dependency caches use file-content hashes, and each gate loads the candidate by staging the exact audited transitive source graph in a fresh location, so the reported source hash is always the executed code. Candidate-local imports must be static; dynamic local imports are rejected by the audit because they would resolve into the removed staging directory at runtime. Accepted phases store geometry, behavior, contract, dependency, and evidence identities. Candidate changes are refused while affected phases remain locked; `reopen` records a reason and invalidates the executable CONTRACT-ORDER suffix `phases[i:]` — the same cumulative model the composition layer uses — rather than a bare dependency closure, so later-phase semantics can never survive a reopen while remaining illegal in active-phase composition. Reopening also prunes generated-module bindings for every invalidated phase (repair-spec binding records and user-authored repair JSON survive), and the trusted pipeline reconciles the workspace's generated registry/modules/manifests from the canonical binding ledger, so stale sidecars can never re-enter composition by being present on disk. Intentional project or contract changes require `rebind`, which starts a new evidence chain. Finalization re-reads the evidence files and rebuilds the live candidate; state booleans are never authority.

Visual review is a separate read-only role. Its packet binds all hashes and immutable captures. When genuine image inspection is unavailable, state remains `awaiting-visual-review`.

## Stylized-authored construction mode

A second construction architecture beside the derived pipeline (see
[stylized-authored-mode.md](stylized-authored-mode.md) for the full mode
documentation). `constructionMode` in `project.json` selects between
`derived-faithful` (legacy default, unchanged behavior) and
`stylized-authored`, where every visible candidate triangle is compiled from
declarative AuthorSpec JSON under `model/stylized/` by the trusted author
compiler (`src/core/author-spec.ts`, `src/core/author-compiler.ts`,
`src/core/authored-candidate.ts`) into `model/.generated-authored/` modules and
a pipeline-owned registry. The prepared oracle becomes a read-only ReferenceScene
(`src/core/reference-scene.ts`) plus low-dimensional measurement guides
(`src/core/oracle-guides.ts`); candidate imports that reach `refs/`,
`.mesh2threejs/oracle/`, `.mesh2threejs/reference-view/`, or the derived
`.generated/` tree fail closed. The mode replaces per-phase immutable locks with
one mutable authoring phase, checkpoints, and a single construction freeze
(`src/core/authoring-state.ts`, `src/core/authoring-freeze.ts`); style
references (`style/references.json` + `style/brief.md`) are hash-bound run
authority (`src/core/style-binding.ts`); `derive` throws
`MODE_FORBIDS_DERIVATION`; and an exact-triangle contamination audit
(`src/core/oracle-copy-audit.ts`) backstops blatant copied components as a
diagnostic. The broker exposes the builder-safe operations `author-status`,
`author-compile`, `author-check`, `author-checkpoint`, `author-measure`,
`reference-scene`, `validate-frozen`, `freeze-construction`, and
`reopen-authoring`; human visual approval authority is unchanged.

## Trusted reconstruction authority

Four authorities are genuinely separate (see the source-authority plan): the **trusted run
authority** (toolchain identity, immutable run policy, canonical record, evaluator, final
replay), the **reconstruction builder** (builder-safe operations only), the **candidate
sandbox** (no workspace state/network/host filesystem; resource-bounded), and the **human
approval channel** (admin capability unavailable to builders).

Core modules: `src/core/run-authority.ts` (canonical record + mirror/drift detection),
`src/core/capabilities.ts` (operation partition),
`src/core/toolchain.ts` (byte-verified manifests, sanitized launch),
`src/core/candidate-executor.ts` + `src/core/candidate-sandbox.ts` (the single execution
path; serialized scenes cross the boundary, never live untrusted objects),
`src/core/scene-serialization.ts`, `src/core/policy.ts`, and `src/broker/*`.

Workspace `.mesh2threejs/state.json` is a mirror of the canonical record for trusted runs;
contradiction fails closed (`WORKSPACE_STATE_DRIFT`). Derived-mode candidates must keep the
pipeline-owned canonical entry and registry (`verifyDerivedLineage`), source assembly
coverage must be complete before registration/derivation (`src/core/assembly.ts`), and
multipart assemblies simplify componentwise with per-component budgets (`derive.ts`).
Generated composition derives from the canonical `state.derivedBindings` ledger — manifest
sidecars are provenance inputs to verification, never phase-presence authority — and the
registry regenerates from that ledger on every derive, reopen, and trusted operation start.
Tank fabrication checks explicit fabrication-critical major masses (canonical `hull` and
`turret`); auxiliary `hull-*` semantics remain validated oracle-relative by hull contiguity
and are never forced into artificial single-island stitches by their name prefix.
`component-keep` repairs have exact, tested semantics: anti-pruning of the targeted
semantic's islands on mesh-simplify phases, or preservation of pivot-owned source geometry
on the axis-fit gun phase (emitted without a duplicate semanticId so the runtime snapshot
attributes it to the pivot); inapplicable keep targets fail derive clearly.
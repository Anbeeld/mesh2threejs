# mesh2threejs — Agentic GLB-to-Three.js pipeline

`mesh2threejs` is an agentic pipeline for recreating a reference GLB as editable, procedural Three.js code. It records the reference with provenance and hashes, measures it, guides the agent through construction and repair, renders matched comparisons, and keeps enough evidence to resume or verify the work later.

It is intended for rigid hard-surface subjects such as vehicles, tanks, buildings, machines, and props. It is not a mesh converter.

The architecture is strategy-neutral about how geometry is authored:

- **source oracle at runtime** — forbidden. The finished candidate never loads or embeds `refs/oracle/*` or `.mesh2threejs/oracle/*`.
- **source-derived build seed** — default for new 3D-oracle projects (`authorshipMode: "derived"`). Trusted pipeline tools simplify prepared-oracle geometry into generated modules under `model/.generated/`, hash-bound to the current preparation, so the agent repairs already-correct low-poly shape instead of reconstructing from zero.
- **independent clean-room rebuild** — optional (`init ... --authorship independent`). Source topology may be measured but never reused; the agent authors everything procedurally.

In both modes the hand-authored source stays under the ordinary topology-dump audit; only verified derivation manifests make dense generated modules legal.

## What to give the agent

Give the agent:

- a local `.glb` reference;
- a short description of the subject and desired style;
- the source, author, license, and redistribution terms for the reference;
- any important parts, repeated-part counts, or moving controls to preserve;
- a subject contract when a generic object needs named sections, landmarks, orientation cues, repeats, attachments, or articulation controls;
- authoritative dimensions and their sources when exact real-world scale matters;
- optional photos or documents that clarify details the GLB does not show.

A useful request looks like this:

> Use the `mesh2threejs` skill to recreate `C:\references\tank.glb` as a low-poly procedural Three.js model. Attribution and license details are in `C:\references\license.txt`. Preserve the rotating turret, elevating gun, tracks, wheel count, cupola, and overall proportions. Use `workspaces/tank-demo` as the workspace.

The agent creates the workspace, copies and verifies the references by default, authors the model under `model/`, and records reports and captures under `.mesh2threejs/`. Each gate and render run gets a new numbered directory, so rerunning a check does not overwrite accepted evidence. If provenance, orientation, scale, or part ownership cannot be established, the agent records the uncertainty instead of guessing.

## What the pipeline produces

A completed workspace can contain:

- an editable module under `model/` that exports `createCandidate()`;
- checked source-reference files and a reproducible preparation recipe;
- geometry, style, complexity, and articulation reports;
- actionable workorders tied to failed measurements;
- matched beauty, silhouette, semantic ID, depth, normal, and material-ID captures;
- comparison boards, turntable frames, per-region diagnostics, and a visual-review verdict bound to files that are re-hashed during finalization;
- resumable state, attribution requirements, intentional simplifications, and the final candidate hash.

Tank projects use dedicated checks for hull, turret, gun, running gear, tracks, fabrication, and articulation. Other rigid objects use a generic three-axis profile.

Certification is `oracle-relative` unless authoritative real-world dimensions and sources support `exact-real`. Generic subject contracts can include or exclude named semantic parts from each dimension, such as excluding an antenna from structural height. Deterministic checks do not substitute for visual review, and the pipeline does not redistribute the reference GLB.

The built-in loader accepts uncompressed glTF 2.0 triangle geometry in GLB containers. It decodes normalized and sparse accessors and applies node transforms, but it does not reproduce skinning or animation. Required Draco or meshopt compression fails with an explicit error. The Node.js CLI uses the deterministic CPU renderer; callers that provide a browser or headless WebGL surface can use the integrated Three.js `WebGLRenderer` path.

## Setup

Node.js 22 or newer is required.

```sh
npm install
npm run build
npm run validate
```

`npm run ci` runs the same contract as CI: development validation, the E2E suite, and a package dry-run. The synthetic scale workloads live behind their own scripts: `npm run benchmark` for the analytical operators and CAD-scale generic evaluator, `npm run benchmark:glb` for generated large-GLB intake, `npm run benchmark:stress` for the multi-component hard-surface workload, and `npm run benchmark:heavy` to run both heavy paths under externally observed memory sampling.

Open this repository in a supported coding agent and ask it to use the root `mesh2threejs` skill. [SKILL.md](SKILL.md) routes the work to the relevant role, profile, and style instructions. [Host validation](docs/host-validation.md) lists tested host capabilities and limitations.

## Starting a workspace

The usual path is to let the CLI copy references into a portable workspace:

```sh
node dist/cli.js init workspaces/demo \
  --id demo \
  --goal "reconstruct the reference as procedural Three.js" \
  --profile generic \
  --oracle C:/references/object.glb \
  --image-ref C:/references/front.jpg \
  --doc-ref C:/references/notes.txt
```

You can also place files in `workspaces/demo/refs/oracle`, `refs/images`, or `refs/docs` before initialization. A single GLB in `refs/oracle` is adopted automatically:

```sh
node dist/cli.js init workspaces/demo \
  --id demo \
  --goal "reconstruct the staged reference" \
  --profile generic
```

If references must remain outside the workspace, opt in explicitly. External paths are absolute and hash-bound, so the workspace is not portable and resume fails if a file is missing or changed:

```sh
node dist/cli.js init workspaces/demo \
  --id demo \
  --goal "reconstruct without copying the source assets" \
  --profile generic \
  --oracle C:/large-assets/object.glb \
  --reference-mode external
```

The stable project configuration lives in `project.json`. Operational state, oracle preparation, evidence, reports, and captures live under `.mesh2threejs/`. Copied workspaces can be moved and resumed from their new location.

## Common commands

Workspace-root commands are the normal interface:

```sh
node dist/cli.js status workspaces/demo
node dist/cli.js next workspaces/demo
node dist/cli.js onboard workspaces/demo --config path/to/onboard.json
node dist/cli.js register workspaces/demo --config path/to/registration.json
node dist/cli.js derive workspaces/demo
node dist/cli.js gate workspaces/demo
node dist/cli.js gate workspaces/demo --global
node dist/cli.js workorders workspaces/demo
node dist/cli.js lock workspaces/demo
node dist/cli.js render workspaces/demo
node dist/cli.js render workspaces/demo --phase active --quick
node dist/cli.js review-ready workspaces/demo
node dist/cli.js prepare-review workspaces/demo
node dist/cli.js review-status workspaces/demo
node dist/cli.js record-review workspaces/demo --verdict path/to/verdict.json
node dist/cli.js reopen workspaces/demo --phase primary-mass --reason "proportion regression"
node dist/cli.js viewer start workspaces/demo
node dist/cli.js viewer stop workspaces/demo
node dist/cli.js finalize workspaces/demo
```

The `onboard` configuration supplies provenance, coordinate-frame, normalization, semantic-map, and ownership facts. A declared `sourceFrame` is executable: onboarding validates it and every prepared-oracle load applies the derived source-to-canonical rotation before user normalization, so a frame declaration always transforms geometry or fails closed. A `logicalOwnership` overlay is validated as a graph (no cycles, no contradictory containment) and consumed by measurement, so a flat source hierarchy measures as logically nested. An onboarded `scaleAuthority` block (a preferred dimension anchor or explicit oracle-units mode) becomes part of preparation identity and registration verifies actual scale against it. `gate` executes only the active phase and its already-locked prerequisites: future phases are neither evaluated nor recorded, a partial candidate without articulation controls can be gated until the phase that owns them, and output stays phase-local. Tank gates additionally refuse future-phase semantics in the live candidate (phase-scope check), and every failed active gate automatically feeds the attempt/stagnation state, so three equivalent no-progress failures route to diagnose without manual bookkeeping. Use `--global` for the explicit complete evaluation, which requires those controls. Tank registration additionally proves the physical canonical frame mechanically — wheel-chain spread, track-pair separation, neutral gun-forward alignment, ground contact — and locking tank registration requires an `oracle-sanity` capture board of the prepared oracle. `workorders` selects the next repair group for the active phase, and `lock` uses that phase's measured geometry and authoritative evidence by default.

In derived-mode workspaces, `derive` creates the best cheap source-derived seed for the active phase: hull/turret use bounded-tier `meshoptimizer` simplification of the prepared semantic geometry (with conservative component pruning), running gear uses measured radial fits, tracks regenerate continuous courses, and gun regenerates from its measured pivot/axis/length. Tiers are selected by running the real deterministic gates; the simplest passing tier wins, otherwise the best tier is retained with failing workorders. Generated modules land in `model/.generated/` with provenance manifests under `.mesh2threejs/derived/`, are legal only while bound to the current preparation, and keep the candidate runtime-independent. `render --phase active --quick` captures side/front/perspective comparison boards as agent-only diagnostics; they record no evidence and never satisfy visual review. `render` records captures, region diagnostics, and turntable evidence. `prepare-review` builds a packet from the current workspace and checks every referenced file before an external reviewer inspects it. Low-level manifest, module, and state-file arguments remain available for scripts; run `node dist/cli.js help` for the complete command list.

`project.json`, profile contracts, style contracts, and subject contracts are hash-bound to state. After an intentional configuration or referenced-contract change, run `node dist/cli.js rebind workspaces/demo`; this archives the active oracle preparation under `.mesh2threejs/oracle/archive/`, discards prior authority, and starts a clean evidence chain. Ordinary candidate edits use the normal gate/reopen lifecycle and do not require project rebinding. Oracle repair follows the same rule in place: the repaired preparation replaces the bound one, and registration plus all downstream evidence is invalidated automatically.

Existing workspaces from the previous root-level layout can be upgraded with:

```sh
node dist/cli.js migrate path/to/workspace
```

Migration keeps the old layout under `.mesh2threejs/legacy`, retains its history, and invalidates prior oracle-bound evidence so the imported reference is checked again.

## Inspect the current model

Refresh the full capture evidence for the live candidate and report its paths:

```sh
node dist/cli.js review-ready workspaces/demo
```

This runs the same render implementation as `node dist/cli.js render workspaces/demo` and returns the capture run directory, render manifest, comparison boards, and turntable for the current gated candidate — always a new `render-NNNN` run, never a reuse of stale output. It never starts the viewer.

For interactive inspection of the same audited candidate — real `WebGLRenderer`, orbit/zoom/pan, canonical camera presets, contract-driven articulation sliders (`setPose`), and automatic reload when the candidate source changes:

```sh
node dist/cli.js viewer start workspaces/demo
node dist/cli.js viewer status workspaces/demo
node dist/cli.js viewer stop workspaces/demo
```

The viewer is an optional persistent localhost tool that survives the launching process. It serves only the viewer app, vendored Three.js modules, and the exact audited candidate source graph; `refs/`, `.mesh2threejs/`, and the oracle are never web-accessible. Viewer use is human inspection convenience only: it is not certification evidence, does not satisfy visual review, and agents must not start it without explicit user approval.

See the [architecture guide](docs/architecture.md) for the engine design. The `examples/` directory contains generic and tank candidate modules.

This repository is development-validated through its protected regression suite and analytical/synthetic scale workloads; a real reconstruction campaign is the next validation step. Production certification of a reconstruction still depends on its onboarded reference, complete evidence chain, and genuine external visual review.

## Credits

Reference-GLB oracle handling, vertex extraction/workorders, and tank gate doctrine were adapted from [Kevin B. Liu's Claude-of-Tanks](https://github.com/Kevin-Liu-01/Claude-of-Tanks), licensed under MIT.

GLB probe/readiness, durable state/render contracts, and staged pass/self-correction concepts were adapted from [img2threejs](https://github.com/img2threejs/img2threejs), licensed under Apache-2.0. Mesh simplification in derived mode uses [meshoptimizer](https://github.com/zeux/meshoptimizer), licensed under MIT.

Neither upstream project supplies the derived-seed mechanism; that is a mesh2threejs-specific correction built on the observed failure modes of fully independent reconstruction. The upstream sources do not copy source geometry into their products, and mesh2threejs keeps that runtime boundary while making build-time derivation an explicit, audited strategy.

This repository is MIT-licensed. [NOTICE](NOTICE) and the [upstream source map](docs/upstream-map.md) record exact audited revisions, licenses, and file-level adaptation details. Third-party reference assets keep their own licenses.

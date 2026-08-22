# mesh2threejs

`mesh2threejs` is an agent-driven pipeline for recreating a reference GLB as editable procedural Three.js code. It measures the reference, guides the agent through construction and repair, renders matched comparisons, and keeps enough evidence to resume or verify the work later.

It is intended for rigid hard-surface subjects such as vehicles, tanks, buildings, machines, and props. It is not a mesh converter. The finished model is independently authored from Three.js primitives, procedural geometry, transforms, materials, named parts, and real articulation controls. It does not load or embed the source mesh.

## What to give the agent

Give the agent:

- a local `.glb` reference;
- a short description of the subject and desired style;
- the source, author, license, and redistribution terms for the reference;
- any important parts, repeated-part counts, or moving controls to preserve;
- authoritative dimensions and their sources when exact real-world scale matters;
- optional photos or documents that clarify details the GLB does not show.

A useful request looks like this:

> Use the `mesh2threejs` skill to recreate `C:\references\tank.glb` as a low-poly procedural Three.js model. Attribution and license details are in `C:\references\license.txt`. Preserve the rotating turret, elevating gun, tracks, wheel count, cupola, and overall proportions. Use `workspaces/tank-demo` as the workspace.

The agent creates the workspace, copies and verifies the references by default, authors the model under `model/`, and records reports and captures under `.mesh2threejs/`. If provenance, orientation, scale, or part ownership cannot be established, it records the uncertainty instead of guessing.

## What the pipeline produces

A completed workspace can contain:

- an editable module under `model/` that exports `createCandidate()`;
- immutable source-reference hashes and a reproducible preparation recipe;
- geometry, style, complexity, and articulation reports;
- actionable workorders tied to failed measurements;
- matched beauty, silhouette, semantic ID, depth, normal, and material-ID captures;
- comparison boards, turntable frames, and a hash-bound visual-review verdict;
- resumable state, attribution requirements, intentional simplifications, and the final candidate hash.

Tank projects use dedicated checks for hull, turret, gun, running gear, tracks, fabrication, and articulation. Other rigid objects use a generic three-axis profile.

Certification is `oracle-relative` unless authoritative real-world dimensions and sources support `exact-real`. Deterministic checks do not substitute for visual review, and the pipeline does not redistribute the reference GLB.

## Setup

Node.js 22 or newer is required.

```sh
npm install
npm run build
npm run validate
```

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
node dist/cli.js gate workspaces/demo
node dist/cli.js render workspaces/demo
node dist/cli.js reopen workspaces/demo --phase primary-mass --reason "proportion regression"
node dist/cli.js finalize workspaces/demo
```

The `onboard` configuration supplies provenance, coordinate-frame, normalization, and semantic-map facts. Workspace paths for the source, prepared recipe, candidate, reports, and captures are resolved automatically. Low-level manifest, module, and state-file arguments remain available for scripts; run `node dist/cli.js help` for the complete command list.

Existing workspaces from the previous root-level layout can be upgraded with:

```sh
node dist/cli.js migrate path/to/workspace
```

Migration keeps the old layout under `.mesh2threejs/legacy`, retains its history, and invalidates prior oracle-bound evidence so the imported reference is checked again.

See the [architecture guide](docs/architecture.md) for the engine design. The `examples/` directory contains generic and tank candidate modules.

## Credits

Tank measurement, construction, and comparison ideas were adapted from [Kevin B. Liu's Claude-of-Tanks](https://github.com/Kevin-Liu-01/Claude-of-Tanks), licensed under MIT.

GLB intake, semantic-readiness, durable-state, and shared-rendering ideas were adapted from [img2threejs](https://github.com/img2threejs/img2threejs), licensed under Apache-2.0.

This repository is MIT-licensed. [NOTICE](NOTICE) and the [upstream source map](docs/upstream-map.md) record exact audited revisions, licenses, and file-level adaptation details. Third-party reference assets keep their own licenses.

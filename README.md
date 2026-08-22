# mesh2threejs

Give an agent a local GLB reference and `mesh2threejs` will build a separate, procedural Three.js recreation of it. The pipeline measures the live reference, writes editable Three.js source, checks the result from multiple views, and keeps iterating until the required geometry, style, and review gates pass.

It is designed for rigid hard-surface subjects such as tanks, vehicles, buildings, machines, and props. The included `low-poly-faithful` style simplifies tessellation and microdetail while preserving the object's dimensions, silhouette, orientation, major parts, repeated-part counts, and articulation.

This is not a GLB converter. The result is independently authored Three.js code that recreates the reference with primitives, procedural lofts, transforms, materials, semantic parts, and explicit pivots. The source GLB is used only as a measured oracle and is never embedded in the candidate.

## What to give the agent

Provide:

- the local path to a `.glb` reference;
- a short description of the subject and the desired result;
- the model's source, author, license, and redistribution terms;
- optional authoritative dimensions and their sources, especially for real tanks;
- any important parts, articulation, or simplifications that must be preserved.

For example:

> Use the `mesh2threejs` skill to recreate `C:\references\tank.glb` as a low-poly, procedural Three.js model. Read the actual author, source URL, license, and redistribution terms from `C:\references\license.txt` before onboarding it. Preserve the rotating turret, elevating gun, wheel count, tracks, cupola, and overall dimensions. Put the task workspace in `workspaces/tank-demo`.

If provenance, coordinate orientation, semantic ownership, or scale cannot be established safely, the agent will stop certification and record what remains unresolved instead of guessing.

## What the pipeline does

The agent will:

1. inspect the GLB, record provenance, and create an immutable source hash;
2. normalize scale, orientation, grounding, semantic parts, and articulation pivots without changing the source file;
3. author a standalone procedural candidate module;
4. compare the candidate with the live oracle using dimensions, silhouettes, sections, landmarks, connectivity, and profile-specific gates;
5. render beauty, silhouette, semantic ID, depth, normal, and material diagnostic passes;
6. turn failures into precise workorders and repair the candidate;
7. run a separate-process critic and certify only evidence bound to the final candidate hash.

Tank tasks use dedicated hull, turret, gun, running-gear, track, fabrication, and articulation checks. Other rigid objects use the generic three-axis profile without loading tank-specific instructions.

## What you receive

A completed workspace contains:

- editable procedural Three.js source exporting `createCandidate()`;
- geometry and style/complexity reports;
- actionable workorders for any failed measurements;
- six diagnostic capture passes, a comparison board, and turntable frames;
- a hash-bound critic verdict and resumable task state;
- recorded simplifications, oracle attribution requirements, and final candidate hash.

Certification is either `oracle-relative` or `exact-real`. `exact-real` is available for tanks only when authoritative real-world dimensions and their sources have been admitted. The pipeline does not package or redistribute the source GLB automatically.

The built-in critic runs in an isolated process, but it is not represented as a second AI model. A capable host may add calibrated visual findings to the same hash-bound evidence packet.

## Setup

Requires Node.js 22 or newer.

```sh
npm install
npm run build
npm run validate
```

Open this repository in a supported coding agent and ask it to use the root `mesh2threejs` skill. The root [SKILL.md](SKILL.md) routes the task and loads only the relevant role, profile, and style instructions. See [host validation](docs/host-validation.md) for tested host capabilities and limitations.

## CLI for manual or scripted use

The agent uses the same host-neutral CLI that is available to developers:

```sh
node dist/cli.js route "reconstruct this tracked armored vehicle"
node dist/cli.js init --workspace workspaces/demo --id demo --goal "reconstruct oracle" --profile tank --oracle oracle/manifest.json --candidate candidate/candidate.mjs
node dist/cli.js probe path/to/source.glb
node dist/cli.js onboard --config path/to/onboard.json --out workspaces/demo/oracle/manifest.json
node dist/cli.js audit-candidate workspaces/demo/candidate/candidate.mjs
node dist/cli.js gate --oracle workspaces/demo/oracle/manifest.json --candidate workspaces/demo/candidate/candidate.mjs --profile tank --out workspaces/demo/reports/gate.json
node dist/cli.js critic workspaces/demo/critic/packet.json --out workspaces/demo/critic/verdict.json
node dist/cli.js finalize workspaces/demo/state.json
```

Run `node dist/cli.js help` for all commands. The [architecture guide](docs/architecture.md) explains the engine, and the `examples/` directory contains complete generic and tank candidate modules.

## Credits and provenance

The tank measurement and construction doctrine adapts ideas from [Claude-of-Tanks by Kevin B. Liu](https://github.com/Kevin-Liu-01/Claude-of-Tanks/tree/f389f13f829451d64cf780c5f14473527b45f7f4), used under the [MIT License](https://github.com/Kevin-Liu-01/Claude-of-Tanks/blob/f389f13f829451d64cf780c5f14473527b45f7f4/LICENSE).

The GLB intake, semantic-readiness, durable-state, and shared-render-contract architecture was informed by [img2threejs](https://github.com/img2threejs/img2threejs/tree/d6673386f89673a58736f8d398dd16ece67874f5), used under the [Apache License 2.0](https://github.com/img2threejs/img2threejs/blob/d6673386f89673a58736f8d398dd16ece67874f5/LICENSE).

This repository is MIT-licensed. See [NOTICE](NOTICE) and the detailed [upstream source map](docs/upstream-map.md) for file-level attribution and adaptation notes. Third-party oracle assets retain their own licenses.

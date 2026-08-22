# mesh2threejs

`mesh2threejs` helps a coding agent recreate a reference GLB as editable, independently authored procedural Three.js. It measures the live reference, guides construction with physical workorders, checks the result from several views and poses, and preserves durable evidence between sessions.

It targets rigid hard-surface subjects—tanks, vehicles, buildings, machines, and props. It is not a GLB converter: candidate code must use native Three.js primitives, procedural geometry, transforms, materials, semantic parts, and real articulation controls. Candidate code may never load or embed the reference.

## What to give the agent

Provide:

- the local path to a `.glb` reference;
- a short description of the subject and the desired result;
- the model's source, author, license, and redistribution terms;
- optional authoritative dimensions and their sources, especially for real tanks;
- important parts, moving controls, and acceptable simplifications.

For example:

> Use the `mesh2threejs` skill to recreate `C:\references\tank.glb` as a low-poly, procedural Three.js model. Read the actual author, source URL, license, and redistribution terms from `C:\references\license.txt` before onboarding it. Preserve the rotating turret, elevating gun, wheel count, tracks, cupola, and overall dimensions. Put the task workspace in `workspaces/tank-demo`.

If provenance, orientation, semantic ownership, or scale cannot be established, the workspace records the unresolved issue instead of inventing an answer.

## What the pipeline does

The agent will:

1. inspect the GLB, record provenance, and create an immutable source hash;
2. prepare a hash-linked normalization and semantic map without changing the source file;
3. author a standalone procedural candidate module;
4. compare the candidate with the live oracle using dimensions, silhouettes, sections, landmarks, connectivity, and profile-specific gates;
5. render matched beauty, silhouette, semantic ID, depth, normal, and material passes, including an actual Three.js WebGL path;
6. turn failures into precise workorders and repair the candidate;
7. lock accepted phases, reopen affected dependants explicitly after changes, and wait for genuine visual review before certification.

Tank tasks use dedicated hull, turret, gun, running-gear, track, fabrication, and articulation checks. Other rigid objects use the generic three-axis profile without loading tank-specific instructions.

## What you receive

A completed workspace contains:

- editable procedural Three.js source exporting `createCandidate()`;
- geometry and style/complexity reports;
- actionable workorders for any failed measurements;
- six diagnostic capture passes, a comparison board, and turntable frames;
- a hash-bound visual-review packet/verdict and resumable task state;
- recorded simplifications, oracle attribution requirements, and final candidate hash.

Results have explicit states: `measured`, `geometry-passed`, `awaiting-visual-review`, `visual-passed`, and `certified`. Certification is `oracle-relative` unless authoritative real-world dimensions and their sources were admitted for `exact-real`. A deterministic replay or isolated Node process does not count as visual review. The pipeline does not redistribute the reference GLB.

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
node dist/cli.js status workspaces/demo/state.json
node dist/cli.js next workspaces/demo/state.json
node dist/cli.js reopen workspaces/demo/state.json --phase hull --reason "station regression"
node dist/cli.js finalize workspaces/demo/state.json
```

Run `node dist/cli.js help` for all commands. The [architecture guide](docs/architecture.md) explains the engine, and the `examples/` directory contains complete generic and tank candidate modules.

## Credits and provenance

Tank measurement and construction ideas are credited to [Claude-of-Tanks by Kevin B. Liu](https://github.com/Kevin-Liu-01/Claude-of-Tanks/tree/f389f13f829451d64cf780c5f14473527b45f7f4), under its [MIT License](https://github.com/Kevin-Liu-01/Claude-of-Tanks/blob/f389f13f829451d64cf780c5f14473527b45f7f4/LICENSE).

GLB intake, semantic readiness, durable state, and shared rendering concepts are credited to [img2threejs](https://github.com/img2threejs/img2threejs/tree/d6673386f89673a58736f8d398dd16ece67874f5), under its [Apache License 2.0](https://github.com/img2threejs/img2threejs/blob/d6673386f89673a58736f8d398dd16ece67874f5/LICENSE).

This repository is MIT-licensed. See [NOTICE](NOTICE) and the detailed [upstream source map](docs/upstream-map.md) for file-level attribution and adaptation notes. Third-party oracle assets retain their own licenses.

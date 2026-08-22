# mesh2threejs

`mesh2threejs` reconstructs an admitted live GLB oracle as independently authored procedural/native Three.js. It supports sibling tank and generic rigid hard-surface profiles, deterministic six-pass CPU captures, CoT-derived geometry gates, an anti-gaming low-poly style contract, durable hash-bound state, and a separate-process critic.

## Requirements and setup

- Node.js 22 or newer
- A local GLB whose provenance and redistribution terms you can record

```sh
npm install
npm run validate
npm run build
node dist/cli.js help
```

## Workflow

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

The candidate module exports `createCandidate(): THREE.Object3D | Promise<THREE.Object3D>`. It may use Three.js primitives, indexed procedural lofts, transforms, and generated materials. It may not load the oracle or contain a dense topology dump.

Choose `exact-real` only for tanks with admitted authoritative dimensions and cited sources. Otherwise use `oracle-relative`. Source GLBs are never packaged automatically.

## Evidence and outputs

Each workspace contains immutable source/preparation lineage, candidate source, reports/workorders, six diagnostic capture passes, a comparison board, turntable, critic packet/verdict, and resumable `state.json`. Any oracle change invalidates all comparison evidence; a candidate change invalidates geometry/style/critic/turntable evidence.

See `SKILL.md` for routing, `profiles/` for domain standards, `styles/` for the style contract, `docs/architecture.md` for internals, and `docs/host-validation.md` for tested host capability boundaries.

## License and upstream provenance

Repository code is MIT. Adapted upstream concepts and code are recorded in `NOTICE` and `docs/upstream-map.md`. Oracle assets keep their own licenses and are not covered by this repository license.

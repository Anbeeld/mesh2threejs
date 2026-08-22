# Upstream source and license map

Audit date: 2026-08-22. Repositories were inspected at exact commits, not mutable branch names.

| Source | Commit | License | Reuse |
|---|---|---|---|
| [Kevin-Liu-01/Claude-of-Tanks](https://github.com/Kevin-Liu-01/Claude-of-Tanks) | `f389f13f829451d64cf780c5f14473527b45f7f4` | MIT, Kevin B. Liu | Formula/algorithm adaptation and tank doctrine classification |
| [img2threejs/img2threejs](https://github.com/img2threejs/img2threejs) | `d6673386f89673a58736f8d398dd16ece67874f5` | Apache-2.0 | Architecture concepts: GLB probe, semantic readiness, durable state, shared render schema |
| [Anbeeld/PROMPTING.md](https://github.com/Anbeeld/PROMPTING.md) | `ea8c5e7e22134ac57984d67a2cdc7c29c7c4ba90` | MIT, Anbeeld | Prompt design concepts: authority, routing, lifecycle, context selection, evaluation |

## File-level audit

CoT files inspected: `docs/GEOMETRY-GATE.md`, `docs/BUILD-STANDARD.md`, `docs/handoff/tank-generation-program.md`, `tools/procedural-fidelity.html`, `tools/geometry-gate.mjs`, `tools/vertex-extract.mjs`, `tools/vertex-workorder.mjs`, `tools/reference-glb-loader.js`, `src/vehicles/profiles/kit.js`, and the onboarding, oracle-repair, builder, critic, graduate, and land-round skill files.

Direct algorithm adaptation appears in `src/core/compare.ts`: translation-only curve registration, bidirectional missing/excess coverage, trimmed mean/P95 scoring, and the CoT weighting `100 - 12*meanPct - 0.6*p95Pct - 1.5*coverPct`. `src/profiles/tank.ts` adapts hull-pinned category registration and the fourteen-station/two-discard doctrine. `profiles/tank/COT-LAW-MAP.md` classifies retained, replaced, and excluded laws.

img2threejs concepts were reimplemented in TypeScript rather than copied line-for-line: conservative GLB admission (`src/core/oracle.ts`), explicit source/prepared lineage, separated durable state (`src/core/state.ts`), and machine-readable render/workspace contracts. PROMPTING.md influenced the progressive role routing and fail-closed state design; no substantial prose was copied.

Excluded CoT baggage: fleet manifests, spawning, collision/physics, gameplay weapons, balance, preview gallery, and runtime vehicle integration. No upstream models or user oracle assets are shipped.

## Drift snapshot

Remote heads inspected on 2026-08-22. The audited pins above remain unchanged:

- Claude-of-Tanks remote HEAD: `3e868fb2fad7fee9b013dd562f8f961880bdbcb4`, 14 commits beyond the audited pin. The reviewed drift adds world/gameplay work, suspension linkages, vehicle profiles, and track-shoe alignment. Within the adapted geometry-gate path, `docs/geometry-gate/ledger.json` only adds a Leopard evaluation row and updated generated counts. No adapted curve or station formula changed, so no code was auto-merged.
- img2threejs: still `d6673386f89673a58736f8d398dd16ece67874f5`.
- PROMPTING.md remote HEAD and `v1.1.0`: `069bb48508e0d7f83546770d3b04d9eebed5158b`, one commit beyond the audited pin. The instruction audit applied the relevant changes: first-build versus later audit separation, mechanically derived volatile identity, lifecycle enforcement in runtime controls, maintenance metadata, and evaluation-claim discipline. The audited attribution pin remains the earlier revision because no text or code was recopied.

`mesh2threejs upstream-drift` rechecks remote heads and reports changed relevant paths without modifying this repository.

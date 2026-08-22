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

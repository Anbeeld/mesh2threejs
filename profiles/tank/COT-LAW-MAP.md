# Claude-of-Tanks law map

Audited CoT commit: `f389f13f829451d64cf780c5f14473527b45f7f4` (MIT).

| Upstream doctrine | Class | V1 disposition | Implementation |
|---|---|---|---|
| Live transformed geometry is truth | Geometry invariant | Retained | `snapshotScene`, render/measurement gates |
| Bidirectional silhouette coverage | Geometry invariant | Adapted | `scoreSilhouetteCurves` |
| Translation-only registration | Geometry invariant | Retained | curve registration |
| Hull-pinned whole/turret comparison | Geometry invariant | Retained | tank curve categories |
| 14 stations, discard worst 2 | Geometry invariant | Retained | hull station gate |
| Dimensions: 1% grace then strong penalty | Geometry invariant | Retained as 1% pass threshold | tank dimensions |
| Turret/gun ownership and pivots | Semantic/articulation | Retained | semantic mapping and articulation gates |
| Wheel rhythm and track course | Geometry/fabrication | Retained | running-gear/track rows |
| Closed major masses and seated fittings | Fabrication/readability | Retained | watertight/floater rows |
| Exact radial segment counts | Style-sensitive | Replaced | 6–16 segment contract + faceting corridor |
| Micro-fastener/detail requirements | Style-sensitive | Replaced | omit/simplify lists; critical override |
| Fleet gameplay dimensions, spawning, collisions, physics | Game/fleet-specific | Excluded | outside reconstruction domain |
| Weapon gameplay behavior and balance | Game/fleet-specific | Excluded | outside reconstruction domain |

Precedence is oracle geometry, admitted real dimensions, semantic/articulation invariants, StyleContract, then critic readability. Style never weakens macro gates.

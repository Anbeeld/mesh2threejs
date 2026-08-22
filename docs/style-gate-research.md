# Low-poly gate mechanism study

The protected analytical fixtures were written before the final style mechanism. Four candidates were evaluated against the anti-gaming cases in `tests/profiles-style.test.ts`.

| Mechanism | Benefit | Falsifier/result |
|---|---|---|
| A: measurement-class tolerances | Simple | Rejected: global/local tolerance widening lets wrong radius or hull slopes hide behind style |
| B: oracle envelope + feature anchors | Protects macro size and placement | Selected: rejects shifted wheels, wrong footprint, missing critical fittings |
| C: analytical faceting corridor | Predicts regular polygon chord/radius loss | Selected with B: a correct 10-sided wheel/faceted turret passes without a global relaxation |
| D: learned style surrogate | Potential perceptual coverage | Deferred: unnecessary, opaque, nondeterministic, and uncalibrated for V1 |

The selected B+C mechanism computes per-component size/center rows. Its allowance is the fixed 1% macro corridor plus only the analytically expected radial faceting deviation for the candidate segment count. Triangle, mesh, and material caps are independent rows, so a low triangle count cannot loosen geometry.

Protected falsifiers include correct/wrong-radius/shifted ten-sided wheels, correct/wrong turret footprints, omitted bolt vs critical cupola, wrong hull slope, and triangle-budget gaming. Known limit: estimating cylinder sides from triangle count is reliable for the procedural primitive fixtures but only approximate for arbitrary authored topology. The deterministic geometry profile remains authoritative when that estimate is ambiguous.

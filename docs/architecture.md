# Architecture

The system separates truth, construction, measurement, judgment, and state.

```text
immutable GLB -> probe -> prepared recipe -> registered oracle snapshot
                                             | six capture passes
procedural candidate module -> audit -> live candidate snapshot
                                             | profile + style gates
                                             v
                                workorders + hash-bound packet
                                             |
                               separate Node critic process
                                             |
                                  fail-closed state certify
```

`src/core/oracle.ts` parses static GLB 2.0 triangle data without a browser, hashes source bytes, applies a reproducible semantic/normalization recipe, and records repairs as new child recipes. It deliberately rejects unsupported primitives and malformed accessors rather than guessing.

`src/core/geometry.ts` snapshots live world transforms and structural metadata. Measurement/rendering use that snapshot, never cached oracle JSON. `src/core/render.ts` is a deterministic CPU rasterizer for beauty, alpha silhouette, semantic ID, depth, normal, and roughness/material-ID passes.

Profiles compose generic operators. Generic evaluates three-axis dimensions and silhouettes, orientation, attachments, sections/landmarks/connectivity, and critical features. Tank retains hull-pinned CoT curve logic, fourteen stations with two edge outliers discarded, running gear, tracks, articulation ownership, and fabrication gates.

Style uses oracle envelopes and feature centers plus an analytical faceting corridor; complexity is separate and cannot relax macro geometry. `state.ts` binds evidence to exact hashes, invalidates dependents, persists atomically, diagnoses repeated no-progress, and certifies only the complete evidence set.

The critic is structurally read-only: it receives a signed packet over stdin in a fresh Node process and emits JSON. This is process/context independence, not a claim of an independently trained model. Visual findings can be supplied by a host vision review and are preserved in the signed packet.

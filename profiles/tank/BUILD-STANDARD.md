# Tank build standard

Build in locks: registration; hull envelope/stations; turret footprint and placement; gun axis/length; running gear centers/radii/count; track courses; turret-owned fittings/articulation; style/fabrication; final board/turntable.

The hull establishes registration. Whole-vehicle and turret curve comparisons reuse the hull translation and may not self-register. Sample 14 hull stations and discard at most the two worst edge-sensitive stations. Dimensions get 1% grace; `exact-real` requires admitted sources. Fabrication checks the explicit fabrication-critical MAJOR MASSES — the canonical `hull` and `turret` semantics — which must be closed (watertight) and single-island. Auxiliary `hull-*` semantics (fenders, sponsons, skirts) are NOT fabrication-checked by name: they may legitimately remain multiple source-faithful pieces, and `hull.contiguity` is the oracle-relative authority for their structure. Never add connecting bridges, handles, or stitches between legitimate auxiliary pieces to satisfy a connectivity check — arbitrary connecting triangles earn nothing. Turret-owned pieces must be seated, two track courses present, and identity details preserved. Track validation includes a calibrated curved-wrap heuristic and 3D AABB hull-envelope occupancy; it does not claim exact mesh intersection.


## Stylized-authored exception

This standard describes the derived-faithful lock sequence. A workspace declaring
`constructionMode: "stylized-authored"` follows a different authority model
(`docs/stylized-authored-mode.md`): whole-object mutable authoring of declarative
AuthorSpecs under `model/stylized/`, advisory `author-check` diagnostics instead
of per-phase locks, one construction freeze after a final-draft visual checkpoint,
then whole-object deterministic validation and human visual review. Source-derived
geometry routes (derive, source-preserve, repair-as-authoring) are unavailable in
that mode; the oracle is measurement and ghost reference only.

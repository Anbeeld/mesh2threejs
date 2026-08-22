# Tank build standard

Build in locks: registration; hull envelope/stations; turret footprint and placement; gun axis/length; running gear centers/radii/count; track courses; turret-owned fittings/articulation; style/fabrication; final board/turntable.

The hull establishes registration. Whole-vehicle and turret curve comparisons reuse the hull translation and may not self-register. Sample 14 hull stations and discard at most the two worst edge-sensitive stations. Dimensions get 1% grace; `exact-real` requires admitted sources. Major masses must be closed, turret-owned pieces seated, two track courses present, and identity details preserved. Track validation includes a calibrated curved-wrap heuristic and 3D AABB hull-envelope occupancy; it does not claim exact mesh intersection.

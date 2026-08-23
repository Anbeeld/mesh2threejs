# Tank profile

Canonical frame: +X right, +Y up, +Z forward, ground = min Y, neutral gun +Z. Source normalization rotates any input into this frame before registration.

Use only for explicit tanks or unmistakable tracked armored fighting vehicles. Required semantic model: hull/lower and upper masses, turret and pivot, gun and pivot, road wheels, two track courses, and oracle-marked identity fittings. Logical ownership is independent of GLB hierarchy via prepared-oracle overlay.

Tank is a sibling profile, not a thin generic extension. It composes hull-pinned curves, fourteen contour sections (contour shape, not only AABB), principal hull planes, contiguity, turret contour sections, radial wheel truth, track course in canonical axes, and orientation proved from geometry (frame-validated).

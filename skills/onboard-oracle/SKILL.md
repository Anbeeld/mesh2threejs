---
name: onboard-oracle
description: Probe, admit, normalize, semantically map, and register a source GLB oracle with provenance. Use when a task has no valid prepared oracle or registration evidence.
---

# Onboard Oracle

1. Run `mesh2threejs probe <source.glb>`; reject malformed, unsupported, or provenance-unknown inputs.
2. Establish canonical frame (+X right, +Y up, +Z forward, ground minY, gun +Z) and normalize source geometry into it; derive sourceFrame from explicit config or geometry-assisted detection (track pair, wheel chains, gun axis). If confidence insufficient, require manual frame and fail closed — do not silently pick an axis.
3. Preserve source bytes and hash. Write only a hash-bound prepared recipe with explicit semantic, pivot, logical ownership overlay, and normalization maps. Verify ownership graph has no cycles or contradictory maps.
4. Load the prepared oracle and prove forward/up, scale, ground, major semantics, required pivots, and physical frame (lateral/longitudinal/track-pair/gun-forward) with `verifyOracleRegistration`. Require the `mesh2threejs oracle-sanity` capture board (front/rear/left-side/right-side/top/perspective with canonical-frame metadata) and inspect it; tank registration locking fails closed without it — a source whose front image is visibly a side view must not proceed.
5. Save registration evidence and route to build only when it passes. Fused/unnamed geometry stays `insufficient` or `manual-map-required`; never guess.

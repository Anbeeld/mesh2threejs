---
name: onboard-oracle
description: Probe, admit, normalize, semantically map, and register a source GLB oracle with provenance. Use when a task has no valid prepared oracle or registration evidence.
---

# Onboard Oracle

1. Run `mesh2threejs probe <source.glb>`; reject malformed, unsupported, or provenance-unknown inputs.
2. Record source, author, license, redistribution, coordinate axes, grounding, scale, authoritative dimensions and their sources.
3. Preserve source bytes and hash. Write only a hash-bound prepared recipe with explicit semantic, pivot, and normalization maps.
4. Load the prepared oracle and prove forward/up, scale, ground, major semantics, and required pivots with `verifyOracleRegistration`.
5. Save registration evidence and route to build only when it passes. Fused/unnamed geometry stays `insufficient` or `manual-map-required`; never guess.

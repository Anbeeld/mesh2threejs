---
name: repair-oracle
description: Correct a proven prepared-oracle normalization, semantic, pivot, or source-defect issue with immutable lineage. Use only after evidence diagnoses the oracle rather than the candidate.
---

# Repair Prepared Oracle

Mode resolution first: on a trusted run, use broker `repair-oracle`. On an unbound development workspace, use the CLI.

Builder convenience is not a repair reason. Require evidence of wrong axes/scale/ground, semantic ownership, pivot mapping, a proven source defect, or a non-subject assembly element that must be durably excluded.

Durable assembly exclusions: when an assembly contains significant non-subject geometry (display stand, presentation floor, measurement prop, helper mesh), do not set `userData.insignificant` directly — it is non-durable and lost on reload. Instead, use broker `repair-oracle` with `assemblyExclusions: [{ nodeId, kind, reason }]` where `nodeId` is a stable `node:N` identity, `kind` is `non-subject`, `presentation-fixture`, or `microdetail`, and `reason` is required. Required semantics (hull, turret, gun, turret-pivot, gun-pivot) cannot be excluded. Changing exclusions invalidates derived bindings, gate evidence, captures, and review.

Use broker `repair-oracle` (or `repairPreparedOracle` in development mode) to create a new prepared recipe with reason, parent prepared hash, unchanged source hash, and appended history. Never overwrite the immutable GLB. Workspace repair rebinds the new preparation to state and invalidates registration, gates, locks, render evidence, and review authority immediately; re-run registration before returning to build.

This route may not edit candidate source.

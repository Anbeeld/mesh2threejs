---
name: repair-oracle
description: Correct a proven prepared-oracle normalization, semantic, pivot, or source-defect issue with immutable lineage. Use only after evidence diagnoses the oracle rather than the candidate.
---

# Repair Prepared Oracle

Builder convenience is not a repair reason. Require evidence of wrong axes/scale/ground, semantic ownership, pivot mapping, or a proven source defect.

Use `repairPreparedOracle` to create a new prepared recipe with reason, parent prepared hash, unchanged source hash, and appended history. Never overwrite the immutable GLB. Re-run registration and invalidate every comparison artifact before returning to build.

This route may not edit candidate source.

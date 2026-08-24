---
name: finalize
description: Fail-closed certification and user handoff. Certification requires a trusted run authority; development runs refuse it.
---

# Finalize

Certification is a trusted-run operation (fail-closed):

- An unbound (development) workspace has no trusted run and refuses certification. Development runs produce reports but never claim certification.
- A workspace bound to a trusted run (`state.mirrorOfRun`) is finalized by the broker only: the admin channel runs `trusted-finalize`, which freshly replays the whole evaluation through the candidate sandbox, requires the current human approval bound to the exact packet/candidate/oracle/toolchain/replay hashes, and refuses when anything drifted.
- Historical `passed` evidence fields are provenance; they never override current truth. Finalization re-verifies every bound review artifact byte-for-byte BEFORE the fresh replay; any drift is `REVIEW_ARTIFACT_DRIFT` and requires a new review-ready plus human approval.

Finalization still verifies registration, deterministic gate, style, complexity, sampled
articulation when controls are declared, turntable evidence, and human visual approval,
with no blocking unresolved item. `exact-real` additionally requires admitted authoritative
dimensions and sources.

Deliver candidate source, optional export if produced, board, turntable, geometry/style reports, intentional simplifications and omissions, oracle attribution/redistribution requirements, and the final hash. Refresh the full capture (`review-ready`) for the final handoff so the user inspects the certified hashes, then offer the interactive viewer. It is optional, never required for finalization, and started only with explicit user approval. Any requested adjustment reopens the affected phases.
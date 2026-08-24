# Task handoff

Provide the procedural candidate source and final hash, optional export if intentionally produced, profile/style/articulation reports, active or resolved workorders, matched comparison boards, turntable captures, visual-review verdict, intentional simplifications, and reference attribution/redistribution requirements.

Label the exact state: `measured`, `geometry-passed`, `awaiting-visual-review`, `visual-passed`, or `certified`. Also label geometry authority as `oracle-relative` or `exact-real`; the latter requires admitted dimension sources. Any adjustment reopens the earliest affected phase and invalidates its dependants.

User-review handoffs (mid-work or final) first refresh the full capture with `mesh2threejs review-ready <workspace>` and report the capture directory, boards, and turntable. Only then, and only with explicit user approval, may the agent start the optional interactive localhost viewer (`viewer start|status|stop`). Viewer feedback is non-authoritative: it maps back to the owning phase and routes through the normal reopen/repair lifecycle.

## Certification authority

`certified` is a trusted-run label only. A development run stops at `awaiting-visual-review`
(or geometry-passed) and reports `TRUSTED_CERTIFICATION_UNAVAILABLE` if asked to finalize.
Trusted certification additionally requires: a fresh trusted global replay over the current
candidate, human approval bound to the exact packet/candidate/oracle/toolchain/replay
hashes, and trusted execution provenance (trusted-derived-generated or a verified host sandbox). The interactive viewer renders the
trusted serialized evaluated scene for bound workspaces; candidate JavaScript is never
served or executed in the browser in that mode, and viewer start always needs explicit user
approval.
## Closure-pass handoff behavior

Trusted `review-ready` computes the capture set itself, records the full review binding
canonically (packet, replay, candidate, preparation, toolchain, scene + capture hashes),
reports exact paths, and never starts the viewer. Human approval seals from canonical
hashes; trusted finalize runs a fresh global replay first and demands re-approval whenever
that replay differs from the approved binding.
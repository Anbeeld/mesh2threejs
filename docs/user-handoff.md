# Task handoff

Provide the procedural candidate source and final hash, optional export if intentionally produced, profile/style/articulation reports, active or resolved workorders, matched comparison boards, turntable captures, visual-review verdict, intentional simplifications, and reference attribution/redistribution requirements.

Label the exact state: `measured`, `geometry-passed`, `awaiting-visual-review`, `visual-passed`, or `certified`. Also label geometry authority as `oracle-relative` or `exact-real`; the latter requires admitted dimension sources. Any adjustment reopens the earliest affected phase and invalidates its dependants.

User-review handoffs (mid-work or final) first refresh the full capture with `mesh2threejs review-ready <workspace>` and report the capture directory, boards, and turntable. Only then, and only with explicit user approval, may the agent start the optional interactive localhost viewer (`viewer start|status|stop`). Viewer feedback is non-authoritative: it maps back to the owning phase and routes through the normal reopen/repair lifecycle.

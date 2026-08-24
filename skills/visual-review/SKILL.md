---
name: visual-review
description: Judge immutable matched reference/candidate captures with genuine visual inspection; never edit candidate or oracle files.
---

# Visual review

Read the workspace `.mesh2threejs/state.json`, the selected profile rubric, and the visual-review packet. Reopen and verify every referenced capture, board, turntable frame, and diagnostic artifact before inspection.

Inspect beauty, alpha, semantic-ID, depth, normal, and material-ID passes, matched comparison boards, turntable views, and sampled articulation evidence. Report concrete region/view findings with severity, expected correction, and the earliest phase to reopen.

Do not edit any artifact. Do not pass a packet from deterministic rows alone. If this host cannot provide genuine image inspection, return `awaiting-visual-review`; a separate process or replay is not a substitute.

## Review authority split

Automated or model-produced verdicts are **diagnostic data only** (`record-review` stores
them as `automated-visual-diagnostic`; the review status stays `awaiting`). Final approval
authority arrives exclusively through the trusted run authority's human capability, bound
to the exact packet/candidate/oracle/toolchain/replay hashes at approval time; every bound artifact is re-hashed at approval and again at finalization, so the approval always means those exact bytes exist. A builder-
created JSON file can never become human approval.
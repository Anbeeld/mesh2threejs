---
name: reconstruct
description: Route, initialize, and resume a live-oracle procedural Three.js reconstruction. Use for new requests, resumed workspaces, or when the active profile/route must be selected safely.
---

# Reconstruct

1. Read root `SKILL.md`, then hydrate the workspace `project.json` and `.mesh2threejs/state.json`.
2. If no workspace exists, route the subject with `mesh2threejs route`, initialize it, and record the selected profile/style as decisions.
3. Choose `tank` only for explicit or unmistakable tanks/tracked armored vehicles. Use `generic` otherwise.
4. Follow `determineNextAction(state)` and load only the resulting role skill. After registration, build hull → pass + lock before intentionally moving to turret; pending-phase scores are not a to-do list.
5. After the smallest complete first candidate for each major phase, render phase-isolated front/side/top + perspective, and answer: does this read as the same major hard-surface structure? If no, rebuild representation before numeric tuning.
6. Never build from memory or declare completion outside `finalize`.

Do not import the oracle into candidate source. Do not let repair wording authorize candidate edits or review wording authorize mutation.

Treat "show me the current model", "let me inspect it", or "give me progress renders" as user-review handoffs, not reconstruction mutations: refresh the full capture (`review-ready`), report its paths, and then ask before starting the viewer. "Open/start the viewer" is explicit authorization, so `mesh2threejs viewer start <workspace>` may run directly. Map viewer feedback to the owning phase and route it through the normal reopen/repair lifecycle; it never satisfies gates or visual review.

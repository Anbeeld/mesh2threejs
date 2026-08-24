---
name: diagnose
description: Diagnose stalled or contradictory reconstruction evidence and choose a different corrective route. Use after repeated no-progress, state corruption, or incompatible gate signals.
---

# Diagnose

Compare the last three attempts, hashes, metrics, workorders, registration, semantics, render setup, and style contract. Identify the first unsupported assumption: bad registration, wrong profile, incorrect semantic ownership, insufficient measurement, candidate architecture, or style misclassification.
Route contradictions such as high section-envelope but poor silhouette, box/radial mismatch, or frame/camera disagreement to evaluator/oracle diagnosis before further candidate editing.

Record the diagnosis and select a materially different evidence-backed action, guided by the workspace authorship mode:

- **derived mode**: prefer a less aggressive derived seed (`derive --quality balanced|conservative`), protect the failing region/features via a declarative repair spec (model/repairs/<active-phase>.json compiled by derive), or switch representation only for the failing subcomponent.
- **independent mode**: prefer changing the representation/control cage over another scalar sweep of the same primitive family.

Route to onboarding/repair only for oracle defects, build for candidate defects, or visual review for missing human/vision judgment. Never relax assertions merely to obtain a pass.

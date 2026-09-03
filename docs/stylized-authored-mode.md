# Stylized-authored construction mode

Status: implemented (core architecture, trusted routing, authoring lifecycle, synthetic E2E)  
Design source: `mesh2threejs-stylized-authored-mode-design.md` (proposal §0–§54)  
Baseline: `main@5c63b5a91689bb13fb6b8f32548279411f6f836e`

---

## Authority split (memorize this)

```text
oracle is geometry truth
style pack is art-direction truth
candidate geometry is newly authored
human visual review is final style authority
```

The one-line rule for every decision in this mode:

> **Use the oracle as a ruler and a ghost reference, never as construction material.**

## What the mode is

`stylized-authored` is a second construction architecture beside the existing
`derived-faithful` pipeline. It exists because heavy stylization is not mesh
simplification: a source-derived candidate keeps too much source vocabulary, and
algorithmic resampling produces numerically-acceptable but visually-malformed forms.

```text
ConstructionMode = "derived-faithful" | "stylized-authored"
```

- `derived-faithful` — the existing pipeline, byte-for-byte unchanged for legacy
  workspaces (the field is absent on legacy projects/states, which behave exactly
  as before).
- `stylized-authored` — every visible candidate triangle is compiled from a
  declarative **AuthorSpec** by trusted code. The prepared oracle is reduced to a
  read-only **ReferenceScene** plus low-dimensional measurement guides.

Selection happens at workspace creation (`constructionMode` in `project.json`,
settable through trusted intake). It participates in the project configuration
identity and the run policy: switching mode requires a new evidence chain/rebind.

## Core invariants (enforced by code, not prose)

1. **Final geometry is newly authored.** The compiler receives no oracle object;
   there is no `loftFromOracleContour`/`resampleOracle`/`simplifyOracleContour`;
   `derive` throws `MODE_FORBIDS_DERIVATION`; source-derived repair routes and
   `source-preserve` are not construction routes in this mode.
2. **Oracle geometry is read-only reference.** Rendered, measured, sectioned,
   compared — never imported by candidate code. The candidate isolation audit
   rejects any candidate import reaching `refs/`, `.mesh2threejs/oracle/`,
   `.mesh2threejs/reference-view/`, or the derived `.generated/` tree
   (`ORACLE_REFERENCE_IMPORT_FORBIDDEN`).
3. **Style references are independent authority.** `style/references.json` +
   `style/brief.md` are hash-bound into the run; a missing style binding prevents
   freeze (`STYLE_BINDING_REQUIRED`); changed style bytes after freeze are
   `FREEZE_STALE`.
4. **Authoring stays mutable until freeze.** Early milestones are checkpoints,
   not locks. Authority applies once, at construction freeze.
5. **Deterministic PASS is necessary, not approval.** Validation is a guardrail;
   the human visual approval remains authoritative for style.
6. **No hidden source-copy escape route.** Authored composition uses only the
   authored binding ledger (`state.authoredBindings`, distinct from
   `derivedBindings`); the copy audit is a diagnostic backstop, not the primary
   enforcement.

## AuthorSpec v1

Files: `model/stylized/<semantic-id>.json` (one file per semantic, DATA only —
executable files there are a hard failure).

Geometry kinds (v1): `box`, `cylinder`, `tube`, `prism` (authored 2D polygon +
extrude), `loft` (authored rings, equal counts per ring per design Q2), `mesh`
(authored positions/indices). There is no API that resamples source contours.

Materials declare one color space (`colorSpace: "srgb"`); the trusted compiler
converts deterministically to the working space (design §28.3).

Validation fails closed on: non-finite values, invalid indices, unknown keys,
duplicate part/semantic ids, illegal hierarchy/cycles, complexity ceilings,
executable payloads/URLs/imports (all `AUTHOR_SPEC_INVALID`).

Pivot semantics (`kind: "group"`) own zero geometry — transform-only groups whose
bounds are a zero-volume box at the origin (design §28.2). EVERY
`parentSemanticId` must itself have an AuthorSpec: pivots are explicitly authored
as zero-geometry group specs with oracle-measured origins, because the authored
registry composes authored objects only and an unauthored parent would silently
leave the child unparented (a typo is a compile error, never a silent degradation).

## Trusted compilation and composition

```text
model/stylized/*.json
  -> validateAuthorSpec
  -> compileAuthorSpec / emitAuthoredModule (trusted, deterministic)
  -> model/.generated-authored/<semantic>.mjs
  -> model/.generated-authored/registry.mjs (pipeline-owned)
  -> model/model.mjs (stable authored scaffold)
  -> candidate sandbox (bounded child, same as derived runs)
```

Every compiled semantic binds: AuthorSpec hash, compiler version, semantic,
generated module hash, geometry hash, material hash (`.mesh2threejs/authored/manifests/`).
Modules live OUTSIDE the derived `.generated/` tree; the authored entry scaffold
is verified byte-exact (`verifyAuthoredLineage`), and no manifest sidecar can
introduce a source-derived module.

## Oracle ReferenceScene and measurement

- `reference-scene` serializes the prepared oracle (same canonical frame the
  evaluator uses) into `.mesh2threejs/reference-view/oracle-scene.json` with a
  manifest binding preparation identity, source hash, and scene hash. Staleness
  is `REFERENCE_SCENE_STALE`; alignment with evaluator truth is verified.
- `author-measure` returns low-dimensional guides only (semantic bounds, centers,
  origins, dimensions, center distances) — never source topology.
- Measurement notebooks (`model/stylized/measurements.json`) record named scalar
  facts; arrays beyond 3 values (vertex/contour lists) are refused.

## Lifecycle (design §7)

```text
authoring -> frozen -> validated -> visual-review -> approved -> final
             ^                                  |
             +-------- reopen-authoring --------+
```

- Checkpoints (`blockout`, `primary-forms`, `secondary-forms`, `final-draft`)
  are evidence milestones; later edits supersede them. A checkpoint binds
  candidate hash + a fresh capture set hash + a structured builder assessment
  (diagnostic only, never approval).
- `freeze-construction` requires a bound style input and a final-draft
  checkpoint bound to the frozen candidate hash (`VISUAL_CHECKPOINT_REQUIRED`
  otherwise), writes `.mesh2threejs/authoring/freeze.json`, and binds oracle
  preparation, style binding, all spec hashes, feature plan, compiler version,
  compiled graph, neutral geometry, and articulation behavior into one freeze id.
- `reopen-authoring(reason)` returns to mutable authoring and invalidates
  freeze identity, validation evidence, review packet, and human approval; the
  oracle and style bindings survive.
- `validate-frozen` runs the whole-object deterministic gate against the frozen
  candidate and records the outcome against the freeze id. Every post-freeze
  authority boundary first re-verifies the CURRENT freeze from disk
  (`verifyFreezeCurrent`: AuthorSpecs, feature plan, style binding, compiler
  version) plus the bound oracle preparation, so a directly edited spec without
  recompile is `FREEZE_STALE` before any stale module can execute.
- `trustedReplay` is mode-aware: derived runs keep the phase-lock precondition;
  stylized runs require the current freeze plus a passing validation bound to
  that freeze.
- `review-ready` binds the construction freeze id, the style binding hash, and
  the exact style-pack files into BOTH the canonical review binding AND the
  review packet itself (schema v5): `packet.json` carries `constructionFreezeId`,
  `styleBindingHash`, and the style-reference images + written brief as
  `style-reference` files the human is presented while approving. Review
  regeneration is a normal operation (validated/visual-review/approved ->
  visual-review with a new packet, same freeze + passing validation) and never
  requires reopening geometry.
- A written style brief (`style/brief.md`) is REQUIRED at freeze — images alone
  do not encode the art-direction contract.
- Human approval (`approve-review`, human-admin only) advances the authoring
  lifecycle to `approved`; `trusted-finalize` re-verifies every bound review
  artifact, executes a fresh replay, and certifies — closing the chain
  (`approved` -> `final`). Builder self-approval is impossible (403).

## Builder operations (all builder-safe)

```text
author-status | author-compile | author-check | author-checkpoint
author-measure | author-compare | reference-scene | validate-frozen
freeze-construction | reopen-authoring
```

`author-compare` is the minimal comparison surface (Bundle F minimum, design
§12/§40): one operation that produces, for side/front/rear/plan/front-3/4 views,
**Oracle | Candidate | Style-reference** triplet boards plus oracle ghost
overlays (oracle silhouette at 50% over the candidate render). The style column
comes only from the bound style pack. This exists so the builder must actually
LOOK at the art direction — the failure mode that motivated the mode.

Disallowed in this mode: `derive` (`MODE_FORBIDS_DERIVATION`), all
source-derived repair construction, oracle mesh export, oracle→AuthorSpec
conversion. Failure codes: see `src/core/construction-mode.ts`.

## Copy audit (diagnostic backstop)

`auditOracleCopy` quantizes oracle and candidate triangles into canonical world
coordinates, uses orientation-insensitive exact triangle signatures, and reports
per-component exact-area contamination. v1 is diagnostic-warning only; a few
matching landmark vertices or one aligned planar triangle never flags. Hard-fail
thresholds wait for calibration against authored examples (design Q3).

## Verification

- `tests/stylized-authored-mode.test.ts` — schema validation (positive/negative),
  compiler determinism, semantic graph, candidate isolation, ReferenceScene
  alignment/staleness, style binding, copy audit (copied vs fresh vs landmark),
  guides/notebook, full lifecycle state machine.
- `tests/stylized-authored-e2e.test.ts` — the design §47 synthetic terminal E2E
  through the trusted broker: stylized workspace → registration → derive refusal
  → measure/reference scene → compile → author-check → checkpoints → freeze →
  frozen-edit refusal → validate-frozen → reopen → revise → re-freeze.

## Deferred (per design §53 completion record)

- Studio comparison UI (oracle|candidate|style boards, opacity/wireframe
  controls) — the trusted reference-scene and measurement routes exist; the
  browser studio is a follow-on bundle (design §40, Bundle F minimum).
- Contamination-audit hard gates (diagnostic-only in v1 by design).
- The real SweatyPanzer T-34-85 end-to-end authoring campaign (design §48):
  requires the art-directed authored build and human visual approval, which are
  inherently outside deterministic verification.

## Verification (terminal chain)

- `tests/stylized-authored-mode.test.ts` — includes post-freeze staleness
  wiring (edited spec, compiler drift, style-manifest role/entry mutation) and
  unresolvable-external-parent compile refusal.
- `tests/stylized-authored-terminal-e2e.test.ts` — the TERMINAL certification
  E2E through the trusted broker: trusted intake with `constructionMode` ->
  registration -> derive refusal -> fresh AuthorSpec compile -> checkpoints ->
  freeze -> passing `validate-frozen` -> `review-ready` binding
  `constructionFreezeId` + `styleBindingHash` + style-reference captures ->
  builder 403 on approval -> human approval (`approved`) -> `trusted-finalize`
  with fresh replay -> `certified` and authoring status `final`.
- `tests/stylized-authored-e2e.test.ts` — the design §47 authoring-lifecycle
  E2E (tank subject): compile/checkpoint/freeze/validate/reopen/re-freeze.
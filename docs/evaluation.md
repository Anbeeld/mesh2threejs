# Evaluation and reproducibility

`npm run validate` is the development check: strict types, regression/fixture coverage, build, and artifact/schema validation. `npm run test:e2e` is a small analytical smoke test. `npm run benchmark` measures analytical tank operators plus a 3.5-million-triangle synthetic complete generic evaluation, records per-operator elapsed time and observed RSS, and enforces 180-second and 2.5-GiB ceilings. The recorded CPU-only baseline completed the CAD-scale deterministic evaluator in 9.03 seconds with 1.43 GiB peak observed RSS; machine and operator details are in [cad-scale-baseline.json](../benchmarks/cad-scale-baseline.json). These checks characterize development workloads; they do not establish real-oracle or host certification.

Protected tests cover physical reflection despite correct metadata, three-axis turret seating, hull length, explicit semantic dimension policies, per-wheel errors, track envelopes and adversarial fake courses, articulation ownership and behavior identity, open/disconnected masses, staged gate exits, style phase authority, canonical evaluation/cache identities, transitive candidate dependencies, live finalization, and artifact tampering.

Behavioral host trials and large real references remain a separate campaign. The required corpus, falsifiers, telemetry, and claim gates are recorded in [DEFERRED-VERIFICATION.md](DEFERRED-VERIFICATION.md). Until that campaign is completed, describe this repository as development-validated, not production-certified.

For every later stochastic agent run, retain host/model/version/config/tools, repository commit, exact selected instructions, profile/config hashes, artifact hashes, action trace, output, grader, human label, and every trial. Never report best-of-N as reliability.

## Trusted-authority regression suites

The release-protected adversarial suite lives in five files (plan §22):

- `tests/trusted-authority.test.ts` — toolchain tamper/launch-config/dependency attacks,
  capability partition, policy-creation authority, mirror drift, certification preconditions
  and approval-staleness attacks.
- `tests/candidate-sandbox.test.ts` — candidate source-graph boundary and resource-abuse
  fixtures (timeout/OOM/network) with bounded-failure assertions.
- `tests/trusted-lifecycle.test.ts` — condensed §23 lifecycle: real reconstruction binds the
  run authority; workspace edits cannot forge it; finalize/viewer/bind stay ask-first.
- `tests/derived-lineage.test.ts` — canonical entry/registry/five-way binding attacks 36–42.
- `tests/semantic-coverage.test.ts` — multipart assembly coverage attacks 43–46.

Development runs can never certify (`finalize` exits 6); only a trusted broker run with a
fresh passing replay, current human approval, and trusted-derived-generated or trusted-host-sandbox execution certifies.
## Trusted pipeline closure (v1 hardening)

The closure pass (F1–F8) replaced every builder-accessible authority mutation with typed
trusted operations:

- The broker exposes operation-level routes only (`begin-run`, `derive`, `gate`, `lock`,
  `review-ready`, ...); generic `runtime-record`/`transition`/`certify` RPC is gone, and the
  admin token never persists beside builder connection data.
- `src/trusted/pipeline.ts` executes the real reconstruction workflow inside the trusted
  boundary; CLI and broker share one evaluator path (`src/operations/workspace-gate.ts`).
- Trusted derived mode executes zero builder-authored executable files: repairs are
  declarative JSON specs (`schemas/derived-repair.v1.json`) validated mechanically and
  compiled into generated modules by derive; any `model/repairs/*.mjs` fails closed.
- Execution provenance is a runtime fact: `trusted-derived-generated` (no agent code in
  graph), `trusted-host-sandbox` (verified adapter), or `development-untrusted` (never
  certifies). A plain Node child process is never called a security sandbox.
- `review-ready` performs the trusted capture itself and records the FULL review binding
  (packet, replay, candidate, preparation, evaluation identity, toolchain, scene + capture
  hashes) canonically; human approval seals from canonical values only; finalize always
  runs a FRESH global replay before certification.
- Toolchain identity anchors to the shipped `toolchain/manifest.v1.json` generated at pack
  time; installed bytes are recomputed at startup and mismatches refuse. Development
  checkouts carry no shipped manifest and cannot certify.

Regression coverage lives in `tests/trusted-lifecycle.test.ts` (real broker lifecycle),
`tests/trusted-pipeline.test.ts` (injection/tamper/repair-spec attacks), plus the earlier
authority/sandbox/lineage/coverage suites.
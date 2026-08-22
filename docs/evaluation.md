# Evaluation and reproducibility

`npm run validate` is the development check: strict types, regression/fixture coverage, build, and artifact/schema validation. `npm run test:e2e` is a small analytical smoke test. `npm run benchmark` measures analytical tank operators plus a 3.5-million-triangle synthetic complete generic evaluation, records per-operator elapsed time and observed RSS, and enforces 180-second and 2.5-GiB ceilings. The recorded CPU-only baseline completed the CAD-scale deterministic evaluator in 9.03 seconds with 1.43 GiB peak observed RSS; machine and operator details are in [cad-scale-baseline.json](../benchmarks/cad-scale-baseline.json). These checks characterize development workloads; they do not establish real-oracle or host certification.

Protected tests cover physical reflection despite correct metadata, three-axis turret seating, hull length, explicit semantic dimension policies, per-wheel errors, track envelopes and adversarial fake courses, articulation ownership and behavior identity, open/disconnected masses, staged gate exits, style phase authority, canonical evaluation/cache identities, transitive candidate dependencies, live finalization, and artifact tampering.

Behavioral host trials and large real references remain a separate campaign. The required corpus, falsifiers, telemetry, and claim gates are recorded in [DEFERRED-VERIFICATION.md](DEFERRED-VERIFICATION.md). Until that campaign is completed, describe this repository as development-validated, not production-certified.

For every later stochastic agent run, retain host/model/version/config/tools, repository commit, exact selected instructions, profile/config hashes, artifact hashes, action trace, output, grader, human label, and every trial. Never report best-of-N as reliability.

# Evaluation and reproducibility

`npm run validate` is the development check: strict types, regression/fixture coverage, build, and artifact/schema validation. `npm run test:e2e` is a small analytical smoke test, and `npm run benchmark` measures only the bundled analytical geometry/render workload. Neither establishes real-oracle or host certification.

Protected tests cover physical reflection despite correct metadata, three-axis turret seating, hull length, robust height, per-wheel errors, physical track envelopes and fake box tracks, articulation ownership, open/disconnected masses, ambiguous semantics, phase locks, cache identities, transitive candidate dependencies, and artifact tampering.

Behavioral host trials and large real references remain a separate campaign. The required corpus, falsifiers, telemetry, and claim gates are recorded in [DEFERRED-VERIFICATION.md](DEFERRED-VERIFICATION.md). Until that campaign is completed, describe this repository as implementation-complete with development checks—not production-certified.

For every later stochastic agent run, retain host/model/version/config/tools, repository commit, exact selected instructions, profile/config hashes, artifact hashes, action trace, output, grader, human label, and every trial. Never report best-of-N as reliability.

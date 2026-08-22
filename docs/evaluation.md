# Evaluation and reproducibility

`npm run validate` runs strict type checking, all unit/protected fixtures, production build, two end-to-end reconstructions, and the geometry/render benchmark. `npm run test:coverage` enforces coverage floors. `npm pack --dry-run` verifies the distributable surface.

The e2e run creates self-authored tank and generic oracle/candidate pairs, evaluates profile/style gates, writes all six oracle/candidate passes, a comparison board, eight turntable frames, and invokes the critic worker. Temporary artifacts are removed after success; no third-party oracle is shipped.

Critic calibration cases live in `fixtures/critic-calibration/cases.json` with frozen human labels and expected machine verdicts: obvious pass/fail, subtle shape fail, style fail, intentional low-poly pass, and a macro error disguised as low-poly. Disagreements are computed rather than omitted.

For stochastic host-agent experiments, record host/model/version/config/tools/repository commit/task/selected context/hashes/grader/action trace/output/human label and all trials. The core evaluator is deterministic, so best-of-N reporting does not apply to its tests.

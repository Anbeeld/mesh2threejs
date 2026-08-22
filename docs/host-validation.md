# Host status

The Codex, Claude Code, and OpenCode adapters are configuration surfaces only. Their manifests do not prove instruction discovery, permissions, resumption, image inspection, or end-to-end behavior.

All hosts use `npm run build` and `node dist/cli.js`. The durable state exposes the active phase, locks, reopens, attempts, evidence bindings, and visual-review status. A host can certify only after a genuine image-capable reviewer returns a valid immutable-packet verdict. A fresh process running deterministic code does not qualify.

Actual host trials are deferred and listed in [DEFERRED-VERIFICATION.md](DEFERRED-VERIFICATION.md). Adapter capability fields must remain conservative until captured trials support them.

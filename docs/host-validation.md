# Host integration status

This repository ships two runtime classes with different authority:

- **Development (default).** `node dist/cli.js` is a builder-invocable surface. It can gate,
  derive, render, and record evidence for an unbound workspace, but it can never certify:
  `finalize` refuses with `TRUSTED_CERTIFICATION_UNAVAILABLE` (exit 6) or fails certification
  checks with exit 2. A verdict JSON recorded through `record-review` is
  **automated-visual-diagnostic** data only.
- **Trusted.** Trusted operations run through the broker tool server (`src/broker/server.ts`)
  launched from the packaged installation. The broker verifies toolchain bytes at startup,
  strips unsafe launch configuration, owns the canonical run-authority store, and exposes
  builder-safe operations. Human visual approval and trusted finalization require the separate
  admin token delivered to the launching user's console.

## What "trusted" means

In this project, `trusted` means:

- pipeline-controlled operation path
- canonical evaluator/policy
- verified current artifacts
- agent instructed not to mutate pipeline authority
- fresh deterministic replay
- human final review authority

It does NOT mean "secure against a malicious local user/process." The broker/store/staging
separation is ordinary application structure — it ensures authorized bytes are staged outside
the candidate source tree so workspace mutations during one execution cannot change the bytes
selected for that execution. It is not an OS-level security boundary.

## Agent authority discipline

The reconstruction agent is controlled through instructions, not OS permissions:

```
RECONSTRUCTION WORK
  modify workspace reconstruction artifacts only

PIPELINE DEVELOPMENT
  modify repository/toolchain code
```

A reconstruction agent must never silently switch from the first mode to the second.

For any reconstruction run bound to the managed/trusted workflow, the agent contract is:

- You may modify reconstruction workspace candidate/repair data.
- You must not modify repository source code, evaluator code, profile contracts, style
  contracts, schemas to weaken validation, broker/authority implementation, generated
  trust/integrity metadata by hand, package/runtime code, or gate thresholds/pass logic.
- You must not change authorship/policy to escape a failing gate.
- You must not use development-only commands on a managed run.
- You must not manually fabricate evidence, review approval, replay results, locks, or
  certification state.
- If a gate fails: inspect evidence/workorders, repair candidate geometry, re-derive when
  appropriate, repair oracle mapping only when evidence proves the mapping is wrong, or
  otherwise report a blocked/unsupported condition. Never change the judge to make the
  candidate pass.

## Host integration checklist

When integrating with a new agent host, verify:

- which host instructions are discovered (AGENTS.md, SKILL.md, skills/)
- which broker operations are available
- whether image inspection works for visual review
- whether state survives sessions (durable state)
- whether final human review can be performed through the admin channel

These are operational compatibility checks, not security certifications.

## Installed lifecycle evidence

The `test:installed-lifecycle` validation proves the COMPLETE trusted certification path
end-to-end from a clean `npm pack` → `npm install <tgz>` → installed broker → trusted
create-workspace-run → onboard/register/derive/gate/lock → review-ready → human/admin
approve-review → trusted-finalize → certified. This verifies the broker operation chain,
toolchain byte verification, and certification logic.

The `test:installed-lifecycle:negative` validation proves a real reconstruction failure
(mislabeled semantic) is correctly rejected — the lifecycle exits non-zero, and the wrapper
asserts this, exiting 0 for CI.
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, afterAll } from "vitest";
import { assertSafeLaunchEnvironment, establishToolchain, generateToolchainManifest, sanitizeLaunchEnvironment, verifyToolchainManifest } from "../src/core/toolchain.js";
import { assertCapability, classifyOperation } from "../src/core/capabilities.js";
import {
  InMemoryRunAuthorityStore,
  TrustedRunAuthority,
  mirroredTaskState,
  stateMirrorFor,
  detectWorkspaceStateDrift,
} from "../src/core/run-authority.js";
import type { RunPolicy } from "../src/core/policy.js";
import { createTaskState, saveTaskState, loadTaskState, type TaskState } from "../src/core/state.js";
import { sha256 } from "../src/core/hashing.js";

/**
 * Trusted authority regression core (plan §22 attacks: toolchain 1/4/5/6/7, policy 9–15,
 * state/evidence 13/16, review 49–51) plus mirror-drift and capability boundaries.
 */

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mesh2threejs-trusted-"));
  roots.push(root);
  return root;
}

function basePolicy(): RunPolicy {
  return {
    profile: "tank",
    style: "low-poly-faithful",
    certification: "oracle-relative",
    authorshipMode: "derived",
    geometryAuthority: "prepared-oracle",
    oracleReference: { path: "refs/oracle/tank.glb", sha256: "a".repeat(64) },
    subjectContractHash: null,
    goal: "synthetic trusted reconstruction",
  };
}

const toolchain = { toolchainId: "tc-1", runtimeHash: "r", controlHash: "c", dependencyIdentity: "d", packageVersion: "1.0.0" };

/** A TaskState whose phases are all complete: isolates certification bookkeeping. */
function completedState(overrides: Partial<TaskState> = {}): TaskState {
  const state = createTaskState({ taskId: "seed", profile: "tank", style: "low-poly-faithful" });
  for (const phase of Object.keys(state.phaseStatus)) state.phaseStatus[phase] = "passed";
  return Object.assign(state, overrides);
}

describe("launch hygiene and toolchain byte verification (§6)", () => {
  test("unsafe NODE_* launch configuration is stripped/refused (attack 7)", () => {
    const check = sanitizeLaunchEnvironment({ NODE_OPTIONS: "--require evil.js", PATH: "C:/x" });
    expect(check.stripped).toContain("NODE_OPTIONS");
    expect(check.sanitized.PATH).toBe("C:/x");
    expect(() => assertSafeLaunchEnvironment({ NODE_OPTIONS: "--import x" })).toThrow(/unsafe broker launch/i);
    expect(() => assertSafeLaunchEnvironment({})).not.toThrow();
  });

  test("tampered installed bytes are refused even when the manifest declares them good (attacks 1/4)", async () => {
    const pkg = await scratch();
    await mkdir(join(pkg, "dist"), { recursive: true });
    await mkdir(join(pkg, "profiles"), { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: {} }));
    await writeFile(join(pkg, "dist", "evaluator.js"), "export const passed = false;\n");
    await writeFile(join(pkg, "profiles", "contract.json"), "{}");
    const manifest = await generateToolchainManifest(pkg);
    await verifyToolchainManifest(manifest, pkg);
    // Attack 4: dist-only tamper after manifest generation.
    await writeFile(join(pkg, "dist", "evaluator.js"), "export const passed = true;\n");
    await expect(verifyToolchainManifest(manifest, pkg)).rejects.toThrow(/toolchain verification failed/i);
    // Attack 5: profile/style file tamper.
    const manifest2 = await generateToolchainManifest(pkg);
    await writeFile(join(pkg, "profiles", "contract.json"), `{ "weakened": true }`);
    await expect(verifyToolchainManifest(manifest2, pkg)).rejects.toThrow(/toolchain verification failed/i);
  });

  test("dependency identity participates in toolchainId (attack 6)", async () => {
    const a = await scratch();
    const b = await scratch();
    // The ledger hashes INSTALLED dependency bytes, so each fixture carries its own
    // node_modules/three at a different resolved version.
    for (const [root, version] of [[a, "1.0.0"], [b, "2.0.0"]] as const) {
      await mkdir(join(root, "dist"), { recursive: true });
      await mkdir(join(root, "node_modules", "three"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { three: version } }));
      await writeFile(join(root, "dist", "main.js"), "x");
      await writeFile(join(root, "node_modules", "three", "package.json"), JSON.stringify({ name: "three", version, main: "./index.js" }));
      await writeFile(join(root, "node_modules", "three", "index.js"), "export const three = 1;\n");
    }
    const ta = await establishToolchain(a);
    const tb = await establishToolchain(b);
    expect(ta.toolchainId).not.toBe(tb.toolchainId);
  });
});

describe("capability partition (§5)", () => {
  test("human/admin operations are not builder-invocable", () => {
    expect(classifyOperation("gate")).toBe("builder");
    expect(classifyOperation("certify")).toBe("human-admin");
    expect(classifyOperation("record-human-approval")).toBe("human-admin");
    expect(classifyOperation("viewer-start")).toBe("human-admin");
    expect(classifyOperation("bind-oracle")).toBe("development-only");
    expect(() => assertCapability("certify", "builder")).toThrow(/human-admin capability/);
  });
});

describe("run authority policy, mirrors, and certification (§3/§4/§17/§18)", () => {
  test("builders cannot create a weaker-than-default run policy (attacks 9–12, 15)", async () => {
    const authority = new TrustedRunAuthority(new InMemoryRunAuthorityStore());
    await expect(authority.createRun({
      runId: "run-builder-weaker",
      workspaceRoot: ".",
      policy: { ...basePolicy(), authorshipMode: "independent" },
      policyDecisions: [],
      initialState: completedState(),
      toolchain,
      defaults: { hasOracle: true, routedProfile: "tank" },
      requestedBy: "builder",
    })).rejects.toThrow();

    await expect(authority.createRun({
      runId: "run-admin-nodecision",
      workspaceRoot: ".",
      policy: { ...basePolicy(), authorshipMode: "independent" },
      policyDecisions: [],
      initialState: completedState(),
      toolchain,
      defaults: { hasOracle: true, routedProfile: "tank" },
      requestedBy: "human-admin",
    })).rejects.toThrow(/non-default authorship mode requires a recorded/);

    await expect(authority.createRun({
      runId: "run-admin-decision",
      workspaceRoot: ".",
      policy: { ...basePolicy(), authorshipMode: "independent" },
      policyDecisions: [{ field: "authorshipMode", value: "independent", source: "user-policy", reason: "clean-room requirement declared before execution" }],
      initialState: completedState(),
      toolchain,
      defaults: { hasOracle: true, routedProfile: "tank" },
      requestedBy: "human-admin",
    })).resolves.toMatchObject({ policy: { authorshipMode: "independent" } });
  });

  test("editing workspace project/state cannot change canonical policy or status (attacks 13/16)", async () => {
    const root = await mkdtemp(join(tmpdir(), "mesh2threejs-mirror-"));
    roots.push(root);
    const authority = new TrustedRunAuthority(new InMemoryRunAuthorityStore());
    await authority.createRun({
      runId: "run-mirror",
      workspaceRoot: root,
      policy: basePolicy(),
      policyDecisions: [],
      initialState: completedState(),
      toolchain,
      defaults: { hasOracle: true, routedProfile: "tank" },
      requestedBy: "human-admin",
    });
    const created = await authority.readRun("run-mirror");
    const state = mirroredTaskState(created);
    const statePath = join(root, ".mesh2threejs", "state.json");
    await mkdir(join(root, ".mesh2threejs"), { recursive: true });
    await saveTaskState(statePath, { ...state, mirrorOfRun: stateMirrorFor(created) });
    // Builder edits the mirror: flips status to certified and weakens authorship.
    const forged = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    forged.status = "certified";
    forged.authorshipMode = "independent";
    await writeFile(statePath, JSON.stringify(forged));
    // Canonical truth is untouched.
    const record = await authority.readRun("run-mirror");
    expect(record.status).toBe("active");
    expect(record.policy.authorshipMode).toBe("derived");
    // The pipeline's own loader fails closed on the contradictory mirror.
    await expect(loadTaskState(statePath)).rejects.toThrow();
  });

  test("mirror drift detection flags hash/sequence mismatches (attack 21)", async () => {
    const authority = new TrustedRunAuthority(new InMemoryRunAuthorityStore());
    await authority.createRun({
      runId: "run-drift",
      workspaceRoot: ".",
      policy: basePolicy(),
      policyDecisions: [],
      initialState: completedState(),
      toolchain,
      defaults: { hasOracle: true, routedProfile: "tank" },
      requestedBy: "human-admin",
    });
    const record = await authority.readRun("run-drift");
    const mirror = stateMirrorFor(record);
    expect(detectWorkspaceStateDrift(mirror, record)).toBeNull();
    expect(detectWorkspaceStateDrift({ ...mirror, hash: "f".repeat(64) }, record)).toMatch(/hash disagrees/);
    expect(detectWorkspaceStateDrift({ ...mirror, sequence: mirror.sequence + 5 }, record)).toMatch(/sequence is ahead/);
  });

  test("certification demands fresh replay, current approval, trusted execution; changes kill approvals (attacks 49–51)", async () => {
    const authority = new TrustedRunAuthority(new InMemoryRunAuthorityStore());
    // Approval re-verifies bound review bytes, so the fixture workspace carries a real scene file.
    const wsDir = await mkdtemp(join(tmpdir(), "m23-cert-ws-"));
    roots.push(wsDir);
    const sceneBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, scene: true }), "utf8");
    await mkdir(join(wsDir, "captures"), { recursive: true });
    await writeFile(join(wsDir, "captures", "viewer-scene.json"), sceneBytes);
    const seeded = (): TaskState => completedState({
      oraclePreparation: { identity: "prep-1", sourceHash: "s1", preparedHash: "p1" },
      evaluationIdentityHash: "ei-1",
      candidateHash: "cand-1",
      oracleHash: "oracle-1",
    });
    await authority.createRun({
      runId: "run-cert",
      workspaceRoot: wsDir,
      policy: basePolicy(),
      policyDecisions: [],
      initialState: seeded(),
      toolchain,
      defaults: { hasOracle: true, routedProfile: "tank" },
      requestedBy: "human-admin",
      intake: "trusted",
    });
    // No execution authority recorded yet: certification refuses.
    await expect(authority.certify("run-cert", { requestedBy: "human-admin" })).rejects.toThrow(/trusted-derived-generated/);
    // A development/untrusted classification can never certify.
    await expect(authority.recordExecutionAuthority("run-cert", { authority: "development-untrusted", backendId: "bounded-child-process", backendIdentityHash: "bx" })).resolves.toBeTruthy();
    await expect(authority.certify("run-cert", { requestedBy: "human-admin" })).rejects.toThrow(/trusted-derived-generated/);
    await expect(authority.certify("run-cert", { requestedBy: "human-admin" })).rejects.toThrow(/final replay/);

    // Trusted pipeline records runtime facts internally (never via builder RPC).
    await authority.recordExecutionAuthority("run-cert", { authority: "trusted-derived-generated", backendId: "bounded-child-process", backendIdentityHash: "bg" });
    await expect(authority.certify("run-cert", { requestedBy: "human-admin" })).rejects.toThrow(/final replay/);

    const replayRecord = {
      replayHash: "replay-1",
      passed: true,
      evaluationIdentityHash: "ei-1",
      candidateHash: "cand-1",
      oraclePreparationIdentity: "prep-1",
      evaluatedAt: new Date().toISOString(),
    };
    await authority.recordComputedReplay("run-cert", replayRecord);
    await authority.recordComputedReviewPacket("run-cert", {
      packetHash: "packet-1", packetFile: null,
      replayHash: "replay-1",
      candidateHash: "cand-1",
      oraclePreparationIdentity: "prep-1",
      evaluationIdentityHash: "ei-1",
      toolchainId: toolchain.toolchainId,
      scene: { path: "captures/viewer-scene.json", sha256: sha256(sceneBytes), sceneHash: "scene-1" },
      captures: [],
      humanApproval: null,
    });

    // Attack 49: the builder cannot deliver human approval (route/capability absent).
    const adminContext = { requestedBy: "human-admin" as const };
    await expect(authority.approveReview("run-cert", { method: "test-capability" }, { requestedBy: "builder" })).rejects.toThrow(/human-admin capability/);
    await authority.approveReview("run-cert", { method: "test-capability" }, adminContext);
    await expect(authority.certify("run-cert", adminContext)).resolves.toMatchObject({ status: "certified" });

    // A certified run is immutable to further transitions or computed records.
    await expect(authority.applyBuilderTransition("run-cert", { kind: "reopen-phase", phase: "hull", reason: "x" }, { requestedBy: "builder" })).rejects.toThrow(/already certified/);
    await expect(authority.recordComputedReplay("run-cert", replayRecord)).rejects.toThrow(/certified/);

    // On an ACTIVE run, editing the candidate invalidates approval + replay before certify.
    await authority.createRun({
      runId: "run-stale",
      workspaceRoot: ".",
      policy: basePolicy(),
      policyDecisions: [],
      initialState: seeded(),
      toolchain,
      defaults: { hasOracle: true, routedProfile: "tank" },
      requestedBy: "human-admin",
    });
    await authority.recordExecutionAuthority("run-stale", { authority: "trusted-derived-generated", backendId: "bounded-child-process", backendIdentityHash: "bg" });
    await authority.recordComputedCandidate("run-stale", { candidateHash: "cand-1", phaseGeometryHashes: {} });
    await authority.recordComputedReplay("run-stale", replayRecord);
    await authority.recordComputedReviewPacket("run-stale", {
      packetHash: "packet-1", packetFile: null,
      replayHash: "replay-1",
      candidateHash: "cand-1",
      oraclePreparationIdentity: "prep-1",
      evaluationIdentityHash: "ei-1",
      toolchainId: toolchain.toolchainId,
      scene: null,
      captures: [],
      humanApproval: null,
    });
    await authority.approveReview("run-stale", { method: "test-capability" }, adminContext);
    // Candidate edit AFTER approval: approval and replay are invalidated automatically.
    await authority.recordComputedCandidate("run-stale", { candidateHash: "cand-2", phaseGeometryHashes: {} });
    const drifted = await authority.readRun("run-stale");
    expect(drifted.review.humanApproval).toBeNull();
    expect(drifted.finalReplay).toBeNull();
    expect(drifted.status).toBe("active");
    await expect(authority.certify("run-stale", adminContext)).rejects.toThrow();

    // A changed replay hash invalidates an existing approval too.
    await authority.createRun({
      runId: "run-rehash",
      workspaceRoot: ".",
      policy: basePolicy(),
      policyDecisions: [],
      initialState: seeded(),
      toolchain,
      defaults: { hasOracle: true, routedProfile: "tank" },
      requestedBy: "human-admin",
    });
    await authority.recordExecutionAuthority("run-rehash", { authority: "trusted-host-sandbox", backendId: "host-container", backendIdentityHash: "hc" });
    await authority.recordComputedReplay("run-rehash", { ...replayRecord, replayHash: "replay-A" });
    await authority.recordComputedReviewPacket("run-rehash", {
      packetHash: "packet-1", packetFile: null,
      replayHash: "replay-A",
      candidateHash: "cand-1",
      oraclePreparationIdentity: "prep-1",
      evaluationIdentityHash: "ei-1",
      toolchainId: toolchain.toolchainId,
      scene: null,
      captures: [],
      humanApproval: null,
    });
    await authority.approveReview("run-rehash", { method: "test-capability" }, adminContext);
    await authority.recordComputedReplay("run-rehash", { ...replayRecord, replayHash: "replay-B" });
    const rehashed = await authority.readRun("run-rehash");
    expect(rehashed.review.humanApproval).toBeNull();
  });
});

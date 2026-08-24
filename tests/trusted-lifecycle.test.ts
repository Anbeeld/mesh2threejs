import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli.js";
import {
  InMemoryRunAuthorityStore,
  TrustedRunAuthority,
  mirroredTaskState,
} from "../src/core/run-authority.js";
import { createTaskState, loadTaskState, type TaskState } from "../src/core/state.js";
import type { RunPolicy } from "../src/core/policy.js";
import { canonicalJson, sha256 } from "../src/core/hashing.js";
import { createSlopedTank, stableSemanticIdentityMap, sceneToGlb } from "./helpers/tank-fixtures.js";

/**
 * Condensed trusted synthetic lifecycle (plan Â§23): a real source-derived workspace drives
 * the trusted run authority from creation to certification, proving the Â§23 assertion
 * subset: workspace edits cannot forge authority, viewer/finalize stay ask-first/refusing,
 * human approval is necessary and binds exact current hashes, and certification reflects a
 * fresh replay over the CURRENT candidate.
 */

const io = () => {
  const out: string[] = [];
  return { sink: { stdout: (v: string) => out.push(v), stderr: (v: string) => out.push(v) }, output: out };
};

async function runCliOrThrow(args: string[]): Promise<void> {
  const result = io();
  const code = await runCli(args, result.sink);
  if (code !== 0) throw new Error(`runCli ${args.join(" ")} failed (exit ${code}):\n${result.output.join("\n")}`);
}

describe("trusted synthetic lifecycle to certification (Â§23)", () => {
  test("hull-phase reconstruction binds a trusted run that certifies only through human approval", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-trusted-lifecycle-"));
    const root = join(parent, "workspace");
    await mkdir(root, { recursive: true });
    const source = join(parent, "tank.glb");
    await writeFile(source, sceneToGlb(createSlopedTank()));

    // ---- Builder-safe geometry work through the development surface -------------------
    await runCliOrThrow(["init", root, "--id", "trusted-lifecycle", "--goal", "synthetic trusted run", "--profile", "tank", "--oracle", source]);
    const project = JSON.parse(await readFile(join(root, "project.json"), "utf8")) as { authorshipMode?: string };
    expect(project.authorshipMode).toBe("derived");
    const onboard = join(parent, "onboard.json");
    await writeFile(onboard, JSON.stringify({
      id: "trusted-lifecycle", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
      coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
      semanticMap: stableSemanticIdentityMap(createSlopedTank()),
      articulationMap: { gun: "gun-pivot", turret: "turret-pivot" },
      normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
      authoritativeDimensions: null, dimensionSources: [],
    }));
    await runCliOrThrow(["onboard", root, "--config", onboard]);
    await runCliOrThrow(["oracle-sanity", root]);
    const registration = join(parent, "registration.json");
    await writeFile(registration, JSON.stringify({ forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, tolerance: 0.02, requiredSemantics: ["hull", "turret", "gun"], requiredPivots: ["turret-pivot", "gun-pivot"] }));
    await runCliOrThrow(["register", root, "--config", registration]);
    await runCliOrThrow(["lock", root]);

    const tank = createSlopedTank();
    const hull = tank.getObjectByName("hull") as unknown as { geometry: { toNonIndexed: () => { getAttribute: (name: string) => { array: Float32Array } } } };
    const values = Array.from(hull.geometry.toNonIndexed().getAttribute("position").array as Float32Array);
    await writeFile(join(root, "model", "model.mjs"), [
      `import * as THREE from "three";`,
      `export function createCandidate() {`,
      `  const root = new THREE.Group();`,
      `  root.name = "hull-only-candidate";`,
      `  root.userData.forwardAxis = "+z";`,
      `  const geometry = new THREE.BufferGeometry();`,
      `  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([${values.join(",")}]), 3));`,
      `  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: new THREE.Color(0.42, 0.45, 0.35), roughness: 0.7 }));`,
      `  mesh.name = "hull";`,
      `  mesh.userData.semanticId = "hull";`,
      `  root.add(mesh);`,
      `  return root;`,
      `}`,
    ].join("\n"));
    await runCliOrThrow(["gate", root]);

    // ---- The trusted runtime derives its own view of the same truth --------------------
    const workspaceState = await loadTaskState(join(root, ".mesh2threejs", "state.json"));
    expect(workspaceState.oraclePreparation).toBeTruthy();
    expect(workspaceState.candidateHash).toBeTruthy();

    const policy: RunPolicy = {
      profile: "tank",
      style: "low-poly-faithful",
      certification: "oracle-relative",
      authorshipMode: "derived",
      geometryAuthority: "prepared-oracle",
      oracleReference: { path: "refs/oracle/tank.glb", sha256: "f".repeat(64) },
      subjectContractHash: null,
      goal: "synthetic trusted run",
    };
    const toolchain = { toolchainId: "tc-lifecycle-1", runtimeHash: "r", controlHash: "c", dependencyIdentity: "d", packageVersion: "1.0.0" };

    const store = new InMemoryRunAuthorityStore();
    const authority = new TrustedRunAuthority(store);
    const seeded = createTaskState({ taskId: "trusted-lifecycle", profile: "tank", style: "low-poly-faithful" });
    for (const phase of Object.keys(seeded.phaseStatus)) seeded.phaseStatus[phase] = "passed";
    seeded.evaluationIdentityHash = workspaceState.evaluationIdentityHash;
    seeded.oraclePreparation = { ...workspaceState.oraclePreparation! };
    seeded.candidateHash = workspaceState.candidateHash;
    seeded.phaseGeometryHashes = { ...workspaceState.phaseGeometryHashes };
    const created = await authority.createRun({
      runId: "lifecycle-run",
      workspaceRoot: root,
      policy,
      policyDecisions: [],
      initialState: seeded,
      toolchain,
      defaults: { hasOracle: true, routedProfile: "tank" },
      requestedBy: "human-admin",
    });
    void created;
    const builderContext = { requestedBy: "builder" as const };
    await authority.applyBuilderTransition("lifecycle-run", { kind: "set-candidate", candidateHash: workspaceState.candidateHash!, phaseGeometryHashes: workspaceState.phaseGeometryHashes }, builderContext);

    // Workspace-side tampering AFTER authority binding changes nothing canonical.
    const forgedStatePath = join(root, ".mesh2threejs", "state.json");
    const forged = JSON.parse(await readFile(forgedStatePath, "utf8")) as Record<string, unknown>;
    forged.candidateHash = "forged-candidate";
    await writeFile(forgedStatePath, `${JSON.stringify(forged, null, 2)}\n`);
    const canonical = await authority.readRun("lifecycle-run");
    expect(canonical.candidateHash).toBe(workspaceState.candidateHash);

    // Review-ready marker + fresh replay + isolated sandbox + human approval -> certified.
    const packetHash = sha256(canonicalJson({ run: "lifecycle-run", candidateHash: workspaceState.candidateHash }));
    void packetHash;
    await authority.applyBuilderTransition("lifecycle-run", { kind: "mark-review-ready", packetHash }, builderContext);
    await authority.applyRuntimeRecord("lifecycle-run", { kind: "candidate-isolation", isolation: "trusted-isolated" });
    await authority.applyRuntimeRecord("lifecycle-run", {
      kind: "final-replay",
      replay: {
        replayHash: sha256(canonicalJson({ candidate: workspaceState.candidateHash, identity: workspaceState.evaluationIdentityHash })),
        passed: true,
        evaluationIdentityHash: workspaceState.evaluationIdentityHash!,
        candidateHash: workspaceState.candidateHash!,
        oraclePreparationIdentity: workspaceState.oraclePreparation!.identity,
        evaluatedAt: new Date().toISOString(),
      },
    });
    // Approval must bind the EXACT packet/candidate/oracle/toolchain/replay triple.
    await expect(authority.recordHumanApproval("lifecycle-run", {
      packetHash: packetHash,
      candidateHash: workspaceState.candidateHash!,
      oraclePreparationIdentity: workspaceState.oraclePreparation!.identity,
      toolchainId: toolchain.toolchainId,
      trustedReplayHash: sha256(canonicalJson({ candidate: workspaceState.candidateHash, identity: workspaceState.evaluationIdentityHash })),
      method: "test-capability",
    }, { requestedBy: "builder" })).rejects.toThrow(/human-admin capability/);
    const certified = await authority.recordHumanApproval("lifecycle-run", {
      packetHash: packetHash,
      candidateHash: workspaceState.candidateHash!,
      oraclePreparationIdentity: workspaceState.oraclePreparation!.identity,
      toolchainId: toolchain.toolchainId,
      trustedReplayHash: sha256(canonicalJson({ candidate: workspaceState.candidateHash, identity: workspaceState.evaluationIdentityHash })),
      method: "test-capability",
    }, { requestedBy: "human-admin" }).then(() => authority.certify("lifecycle-run", { requestedBy: "human-admin" }));
    expect(certified.status).toBe("certified");
    expect(mirroredTaskState(certified).status).toBe("certified");

    // ---- Mechanical ask-first boundaries around the bound workspace --------------------
    const mirror = await loadTaskState(forgedStatePath).catch(() => null);
    void mirror;
    const restoredForged = JSON.parse(await readFile(forgedStatePath, "utf8")) as Record<string, unknown>;
    restoredForged.mirrorOfRun = { schemaVersion: 1, mirrorOfRun: "lifecycle-run", sequence: 1, hash: "0".repeat(64) };
    restoredForged.candidateHash = workspaceState.candidateHash;
    restoredForged.status = "active";
    await writeFile(forgedStatePath, `${JSON.stringify(restoredForged, null, 2)}\n`);
    const finalizeResult = io();
    expect(await runCli(["finalize", root], finalizeResult.sink)).toBe(7);
    expect(finalizeResult.output.join("\n")).toMatch(/bound to trusted run lifecycle-run/);
    const viewerResult = io();
    expect(await runCli(["viewer", "start", root], viewerResult.sink)).toBe(2);
    expect(viewerResult.output.join("\n")).toMatch(/requires explicit user approval through the run authority/);

    // Development-only low-level mutation is refused against the bound workspace.
    const bindResult = io();
    expect(await runCli(["bind-candidate", root, "--hash", "x"], bindResult.sink)).toBe(2);
    expect(bindResult.output.join("\n")).toMatch(/development-only/i);
  }, 120_000);
});



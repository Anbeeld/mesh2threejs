import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { describe, expect, test, afterAll } from "vitest";
import { startBroker } from "../src/broker/server.js";
import { BrokerClient } from "../src/broker/client.js";
import { sceneToGlb, stableSemanticIdentityMap } from "./helpers/tank-fixtures.js";

/**
 * TERMINAL certification E2E for the stylized-authored mode (lifecycle closure): the full
 * authority chain validate-frozen -> review-ready (packet binds construction freeze + style
 * pack) -> human approval -> fresh replay -> trusted finalize, with NO per-phase locks —
 * the construction freeze is the only geometry authority. Uses the generic profile with a
 * simple synthetic subject so the whole deterministic contract can genuinely pass.
 */

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const toolchainOverride = {
  manifest: {
    schemaVersion: 2 as const, dependencies: [] as never,
    packageName: "mesh2threejs",
    packageVersion: "1.0.0",
    runtimeHash: "test-runtime-hash",
    controlHash: "test-control-hash",
    dependencyIdentity: "test-dependency-identity",
    runtimeFiles: {},
    controlFiles: {},
  },
  provenance: { nodeVersion: process.version, platform: process.platform, arch: process.arch, packageRoot: ".", threeRoot: null, threeVersion: null, meshoptimizerRoot: null, meshoptimizerVersion: null, installationRuntimeClosureHash: null },
  toolchainId: "tc-stylized-terminal-fixed",
  trustedToolchain: true,
};

/** Dense-tessellated single-box oracle: one semantic "primary", grounded at min-y=0. */
function createBoxSubject(): THREE.Group {
  const root = new THREE.Group();
  root.name = "box-subject";
  root.userData.forwardAxis = "+z";
  const geometry = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  geometry.translate(0, 0.5, 0);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x777777 }));
  mesh.name = "primary";
  mesh.userData.semanticId = "primary";
  root.add(mesh);
  return root;
}

describe("stylized-authored terminal certification E2E", () => {
  test("trusted intake -> freeze -> validate-frozen -> review-ready (freeze+style bound) -> approval -> fresh replay -> finalize", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-stylized-terminal-"));
    roots.push(parent);
    const root = join(parent, "workspace");
    const source = join(parent, "box.glb");
    await writeFile(source, sceneToGlb(createBoxSubject()));
    const styleImage = join(parent, "style-ref-01.png");
    await writeFile(styleImage, Buffer.from("style-image-bytes"));

    const broker = await startBroker({ toolchainOverride });
    roots.push(broker.url);
    try {
      const builder = new BrokerClient({ url: broker.url, token: broker.builderToken });
      const admin = new BrokerClient({ url: broker.url, token: broker.adminToken });

      // ---- TRUSTED INTAKE: admin pins goal + oracle + style pack + construction mode ----
      const created = await admin.createWorkspaceRun({
        workspaceRoot: root,
        goal: "simple stylized box subject reconstruction",
        oraclePath: source,
        images: [styleImage],
        constructionMode: "stylized-authored",
      }) as { runId: string; intake?: string };
      const runId = created.runId;
      expect(created.intake).toBe("trusted");
      const record = (await builder.readRun(runId)).record;
      expect(record.policy.constructionMode).toBe("stylized-authored");

      // ---- Oracle onboarding + registration ----------------------------------------------
      await builder.onboardOracle(runId, {
        id: "stylized-terminal", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
        coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
        semanticMap: stableSemanticIdentityMap(createBoxSubject()),
        articulationMap: {},
        normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
        authoritativeDimensions: null, dimensionSources: [],
      });
      const registered = await builder.register(runId, { forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, tolerance: 0.02, requiredSemantics: ["primary"], requiredPivots: [] });
      expect(registered.passed).toBe(true);
      await builder.lock(runId);

      // Derive stays structurally unavailable.
      await expect(builder.derive(runId)).rejects.toThrow(/derive is not a construction route/u);

      // ---- Builder authoring input: style pack + ONE fresh authored spec -----------------
      await mkdir(join(root, "style"), { recursive: true });
      await mkdir(join(root, "model/stylized"), { recursive: true });
      const references = JSON.parse(await readFile(join(root, ".mesh2threejs/references.json"), "utf8")) as { records: Array<{ kind: string; operationalPath: string }> };
      const styleRecord = references.records.find((item) => item.kind === "image")!;
      await writeFile(join(root, "style/references.json"), JSON.stringify({ schemaVersion: 1, references: [{ path: styleRecord.operationalPath, role: "primary-style", notes: "flat facets, single material family" }] }, null, 2));
      await writeFile(join(root, "style/brief.md"), "# Direction\n\nOne clean box. No detail survives.\n");
      await writeFile(join(root, "model/stylized/primary.json"), JSON.stringify({
        schemaVersion: 1,
        semanticId: "primary",
        origin: [0, 0.5, 0],
        material: { colorSpace: "srgb", color: [0.3, 0.3, 0.3], roughness: 0.8, flatShading: true },
        parts: [{ name: "mass", geometry: { kind: "box", size: [1, 1, 1] } }],
      }, null, 2));

      // ---- Compile -> checkpoint -> freeze ------------------------------------------------
      await builder.authorCompile(runId);
      await builder.referenceScene(runId);
      await builder.authorCheckpoint(runId, { kind: "blockout", assessment: { geometry_vs_oracle: { primary: "PASS" } } });
      await builder.authorCheckpoint(runId, { kind: "final-draft", assessment: { geometry_vs_oracle: { primary: "PASS" }, style_vs_references: { abstraction_density: "PASS" } } });
      const frozen = await builder.freezeConstruction(runId) as { status: string; freezeId: string; candidateHash: string };
      expect(frozen.status).toBe("frozen");

      // ---- Deterministic validation bound to the freeze -----------------------------------
      const validation = await builder.validateFrozen(runId) as { status: string; passed: boolean; freezeId: string };
      expect(validation.freezeId).toBe(frozen.freezeId);
      expect(validation.passed, `global validation failed; rows: ${JSON.stringify(validation)}`).toBe(true);
      expect(validation.status).toBe("validated");

      // ---- Review-ready: packet binds construction freeze + style pack --------------------
      const ready = await builder.reviewReady(runId) as { status: string; packet: { hash: string } };
      expect(ready.status).toBe("ready-for-user-review");
      const reviewed = (await builder.readRun(runId)).record;
      expect(reviewed.review.constructionFreezeId).toBe(frozen.freezeId);
      expect(reviewed.review.styleBindingHash).toMatch(/^[a-f0-9]{64}$/);
      expect(reviewed.review.captures.some((capture) => capture.role === "style-reference")).toBe(true);
      const statusAtReview = await builder.authorStatus(runId) as { authoring: { status: string } };
      expect(statusAtReview.authoring.status).toBe("visual-review");

      // ---- Builder cannot self-approve ------------------------------------------------------
      const builderApproval = await fetch(broker.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "approve-review", runId, token: broker.builderToken }) });
      expect(builderApproval.status).toBe(403);

      // ---- Human approval advances the authoring lifecycle to `approved` ------------------
      await admin.approveReview(runId);
      const approvedStatus = await builder.authorStatus(runId) as { authoring: { status: string } };
      expect(approvedStatus.authoring.status).toBe("approved");

      // ---- Finalize: fresh replay + certification closes the chain (approved -> final) ----
      const finalized = await admin.trustedFinalize(runId) as { status: string };
      expect(finalized.status).toBe("certified");
      const finalStatus = await builder.authorStatus(runId) as { authoring: { status: string } };
      expect(finalStatus.authoring.status).toBe("final");
    } finally {
      await broker.close();
    }
  }, 600_000);
});
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, afterAll } from "vitest";
import { PNG } from "pngjs";
import { startBroker } from "../src/broker/server.js";
import { BrokerClient } from "../src/broker/client.js";
import { createSlopedTank, stableSemanticIdentityMap, sceneToGlb } from "./helpers/tank-fixtures.js";
import { initializeWorkspace } from "../src/core/workspace.js";

/**
 * Synthetic terminal E2E for the stylized-authored construction mode (design §47). The full
 * lifecycle flows through the trusted broker: stylized workspace creation, mode-routed derive
 * refusal, AuthorSpec compilation, oracle measurement/reference-view, visual checkpoints,
 * construction freeze, reopen invalidation, and frozen validation. Candidate geometry is
 * authored from declarative AuthorSpecs ONLY — no derive call, no source-derived module.
 */

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Verified toolchain fixture standing in for a shipped-manifest installation. */
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
  toolchainId: "tc-stylized-fixed",
  trustedToolchain: true,
};

describe("stylized-authored terminal E2E (design §47)", () => {
  test("create stylized workspace -> register -> measure/reference -> author/compile -> checkpoints -> freeze -> validate -> reopen -> re-freeze", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-stylized-e2e-"));
    roots.push(parent);
    const root = join(parent, "workspace");
    const source = join(parent, "tank.glb");
    await writeFile(source, sceneToGlb(createSlopedTank()));
    const styleImage = join(parent, "style-ref-01.png");
    const stylePng = new PNG({ width: 64, height: 48 });
    for (let index = 0; index < 64 * 48; index += 1) {
      stylePng.data[index * 4] = 120;
      stylePng.data[index * 4 + 1] = 110;
      stylePng.data[index * 4 + 2] = 40;
      stylePng.data[index * 4 + 3] = 255;
    }
    await writeFile(styleImage, PNG.sync.write(stylePng));

    // Workspace scaffolding (dev surface): stylized mode is declared at CREATION (design §5.1)
    // together with the style reference pack. Every trusted act below goes through the broker.
    await mkdir(join(root, "refs"), { recursive: true });
    const initialized = await initializeWorkspace(root, {
      id: "stylized-e2e",
      goal: "synthetic stylized tank reconstruction",
      profile: "tank",
      style: "low-poly-faithful",
      certification: "oracle-relative",
      oracle: source,
      images: [styleImage],
      referenceMode: "copy",
      authorshipMode: "derived",
      constructionMode: "stylized-authored",
    });
    expect(initialized.project.constructionMode).toBe("stylized-authored");
    const entrySource = await readFile(join(root, "model/model.mjs"), "utf8");
    expect(entrySource).toContain('.generated-authored/registry.mjs');
    const references = JSON.parse(await readFile(join(root, ".mesh2threejs/references.json"), "utf8")) as { records: Array<{ kind: string; operationalPath: string }> };
    const styleRecord = references.records.find((record) => record.kind === "image");
    expect(styleRecord).toBeDefined();
    // Style manifest + brief + authored specs (builder DATA input).
    await mkdir(join(root, "style"), { recursive: true });
    await mkdir(join(root, "model/stylized"), { recursive: true });
    await writeFile(join(root, "style/references.json"), JSON.stringify({ schemaVersion: 1, references: [{ path: styleRecord!.operationalPath, role: "primary-style", notes: "abstraction and facet language only" }] }, null, 2));
    await writeFile(join(root, "style/brief.md"), "# SweatyPanzer-style direction\n\nBroad planes, chunky facets, coarse wheels, few material families.\n");
    await writeFile(join(root, "model/stylized/feature-plan.yaml"), "hull:\n  keep: [macro-shell]\n  omit: [grab-handles, bolts]\n");
    for (const [semantic, spec] of Object.entries(authoredSpecs(styleRecord!.operationalPath))) {
      await writeFile(join(root, "model/stylized", `${semantic}.json`), JSON.stringify(spec, null, 2));
    }

    const broker = await startBroker({ toolchainOverride });
    roots.push(broker.url);
    try {
      const builder = new BrokerClient({ url: broker.url, token: broker.builderToken });
      const admin = new BrokerClient({ url: broker.url, token: broker.adminToken });

      // ---- Run creation binds the declared construction mode --------------------------
      const begun = await admin.beginRun(root);
      const runId = begun.runId;
      const record = (await builder.readRun(runId)).record;
      expect(record.policy.constructionMode).toBe("stylized-authored");
      expect(record.embedded.state.constructionMode).toBe("stylized-authored");

      // ---- Oracle onboarding + registration (same trusted oracle path) ----------------
      await builder.onboardOracle(runId, {
        id: "stylized-e2e", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
        coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
        semanticMap: stableSemanticIdentityMap(createSlopedTank()),
        articulationMap: { gun: "gun-pivot", turret: "turret-pivot" },
        normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
        authoritativeDimensions: null, dimensionSources: [],
      });
      await builder.oracleSanity(runId);
      const registered = await builder.register(runId, { forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, tolerance: 0.02, requiredSemantics: ["hull", "turret", "gun"], requiredPivots: ["turret-pivot", "gun-pivot"] });
      expect(registered.passed).toBe(true);
      await builder.lock(runId);

      // ---- Hard routing: derive is rejected in stylized-authored mode (§5.2/§33.1) ----
      await expect(builder.derive(runId)).rejects.toThrow(/MODE_FORBIDS_DERIVATION|derive is not a construction route/u);

      // ---- Authoring tooling: measure + reference scene --------------------------------
      const measured = await builder.authorMeasure(runId, ["hull", "turret", "gun-pivot"]) as { guide: { semantics: Array<{ semanticId: string; dimensions: { length: number } }>; reportHash: string } };
      const hullGuide = measured.guide.semantics.find((semantic) => semantic.semanticId === "hull");
      expect(hullGuide).toBeDefined();
      expect(hullGuide!.dimensions.length).toBeGreaterThan(2);
      const scene = await builder.referenceScene(runId) as { status: string; referenceSceneHash: string; aligned: boolean };
      expect(scene.status).toBe("reference-scene-generated");
      expect(scene.aligned).toBe(true);
      expect(scene.referenceSceneHash).toMatch(/^[a-f0-9]{64}$/);
      const sceneBytes = JSON.parse(await readFile(join(root, ".mesh2threejs/reference-view/oracle-scene.json"), "utf8")) as { oraclePreparationIdentity: string };
      expect(sceneBytes.oraclePreparationIdentity).toMatch(/^[\w-]+$/);

      // ---- Compile authored specs -> registry + binding ledger -------------------------
      const compiled = await builder.authorCompile(runId) as { status: string; semantics: string[]; candidateHash: string; styleBinding: { hash: string } | null };
      expect(compiled.status).toBe("compiled");
      expect(compiled.semantics).toContain("hull");
      expect(compiled.candidateHash).toMatch(/^[a-f0-9]{64}$/);
      expect(compiled.styleBinding).not.toBeNull();

      // ---- Minimal Bundle F: Oracle | Candidate | Style boards + ghost overlays ----------
      const compare = await builder.authorCompare(runId) as { status: string; views: string[]; boards: Array<{ view: string }>; ghostOverlays: Array<{ view: string }> };
      expect(compare.status).toBe("author-compare-captured");
      expect(compare.views).toEqual(["side", "front", "rear", "plan", "front-3-4"]);
      expect(compare.boards.length).toBe(5);
      expect(compare.ghostOverlays.length).toBe(3);

      // ---- Advisory diagnostics (author-check) incl. copy audit -----------------------
      const check = await builder.authorCheck(runId) as { copyAudit: { status: string; enforcement: string } };
      expect(check.copyAudit.status).toBe("clean");
      expect(check.copyAudit.enforcement).toBe("diagnostic-warning");

      // ---- Candidate isolation is enforced BEFORE execution (§33.3) ------------------
      await mkdir(join(root, "model/parts"), { recursive: true });
      await writeFile(join(root, "model/parts/evil.mjs"), `import { x } from "../.mesh2threejs/oracle/prepared.json";
export const evil = x;
`);
      await expect(builder.authorCompile(runId)).rejects.toThrow(/forbidden reference data|ORACLE_REFERENCE_IMPORT_FORBIDDEN/u);
      await rm(join(root, "model/parts"), { recursive: true, force: true });

      // ---- Checkpoints are recorded during authoring; freeze needs final-draft --------
      const blockout = await builder.authorCheckpoint(runId, { kind: "blockout", assessment: { geometry_vs_oracle: { hull: "NEEDS_WORK" }, next: ["raise turret"] } }) as { status: string; capturesHash: string };
      expect(blockout.status).toBe("checkpoint-recorded");
      expect(blockout.capturesHash).toMatch(/^[a-f0-9]{64}$/);

      await expect(builder.freezeConstruction(runId)).rejects.toThrow(/VISUAL_CHECKPOINT_REQUIRED|final-draft/u);
      await builder.authorCheckpoint(runId, { kind: "primary-forms", assessment: { geometry_vs_oracle: { turret: "NEEDS_WORK" } } });
      await builder.authorCheckpoint(runId, { kind: "final-draft", assessment: { geometry_vs_oracle: { hull: "PASS", turret: "PASS" }, style_vs_references: { abstraction_density: "PASS" } } });

      // ---- Construction freeze (§19) ---------------------------------------------------
      const frozen = await builder.freezeConstruction(runId) as { status: string; freezeId: string; candidateHash: string };
      expect(frozen.status).toBe("frozen");
      expect(frozen.freezeId).toMatch(/^[a-f0-9]{64}$/);
      const freezeFile = JSON.parse(await readFile(join(root, ".mesh2threejs/authoring/freeze.json"), "utf8")) as { id: string; styleBinding: string; oracleBinding: string };
      expect(freezeFile.id).toBe(frozen.freezeId);
      expect(freezeFile.styleBinding).toMatch(/^[a-f0-9]{64}$/);

      // Frozen authoring refuses edits (AUTHORING_FROZEN).
      await expect(builder.authorCheckpoint(runId, { kind: "blockout" })).rejects.toThrow(/AUTHORING_FROZEN|mutable authoring/u);
      await expect(builder.authorCompile(runId)).rejects.toThrow(/AUTHORING_FROZEN|frozen/u);

      // ---- Deterministic validation of the frozen construction (§20) -------------------
      const validation = await builder.validateFrozen(runId) as { status: string; passed: boolean; freezeId: string };
      expect(validation.freezeId).toBe(frozen.freezeId);
      expect(["validated", "validation-failed"]).toContain(validation.status);

      // ---- Reopen invalidates post-freeze evidence and returns to mutable authoring ----
      const reopened = await builder.reopenAuthoring(runId, "turret facet flow needs rework") as { status: string };
      expect(reopened.status).toBe("authoring-reopened");
      const statusAfter = await builder.authorStatus(runId) as { authoring: { status: string; freeze: unknown; validation: unknown; review: unknown; oracleBinding: string | null; styleBindingHash: string | null } };
      expect(statusAfter.authoring.status).toBe("authoring");
      expect(statusAfter.authoring.freeze).toBeNull();
      expect(statusAfter.authoring.validation).toBeNull();
      expect(statusAfter.authoring.review).toBeNull();
      expect(statusAfter.authoring.oracleBinding).not.toBeNull();
      expect(statusAfter.authoring.styleBindingHash).not.toBeNull();

      // ---- Revise + re-freeze (§47: reopen -> modify -> re-freeze) ----------------------
      const specs = authoredSpecs(styleRecord!.operationalPath);
      const turretSpec = specs.turret as { parts: Array<{ name: string; geometry: { kind: string; rings?: number[][][] } }> };
      const rings = (turretSpec.parts[0]!.geometry as { rings: number[][][] }).rings!;
      (turretSpec.parts[0]!.geometry as { rings: number[][][] }).rings = rings.map((ring) => ring.map((vertex) => [vertex[0]!, vertex[1]! * 1.1, vertex[2]!] as number[]));
      await writeFile(join(root, "model/stylized/turret.json"), JSON.stringify(turretSpec, null, 2));
      await builder.authorCompile(runId);
      await builder.authorCheckpoint(runId, { kind: "final-draft", assessment: { geometry_vs_oracle: { turret: "PASS" } } });
      const refrozen = await builder.freezeConstruction(runId) as { status: string; freezeId: string };
      expect(refrozen.status).toBe("frozen");
      expect(refrozen.freezeId).not.toBe(frozen.freezeId);
      const latest = (await builder.readRun(runId)).record;
      expect(latest.embedded.state.authoring!.status).toBe("frozen");
    } finally {
      await broker.close();
    }
  }, 300_000);
});

/** Fresh-authored blockout specs: oracle measurements as guides, zero oracle topology. */
function authoredSpecs(_styleRef: string): Record<string, unknown> {
  void _styleRef;
  const material = { colorSpace: "srgb", color: [0.18, 0.16, 0.07], roughness: 0.8, flatShading: true };
  const specs: Record<string, unknown> = {
    hull: {
      schemaVersion: 1,
      semanticId: "hull",
      origin: [0, 1.05, 0],
      material,
      parts: [{ name: "armor-shell", geometry: { kind: "box", size: [3.0, 1.1, 5.9] } }],
    },
    "turret-pivot": {
      schemaVersion: 1,
      semanticId: "turret-pivot",
      kind: "group",
      origin: [0, 1.62, -0.5],
      parts: [],
    },
    turret: {
      schemaVersion: 1,
      semanticId: "turret",
      parentSemanticId: "turret-pivot",
      material,
      parts: [{
        name: "cast-shell",
        geometry: {
          kind: "loft",
          rings: [
            [[-0.78, 0, -1.15], [0.78, 0, -1.15], [1.02, 0, -0.4], [0.95, 0, 0.55], [0.55, 0, 1.05], [-0.55, 0, 1.05], [-0.95, 0, 0.55], [-1.02, 0, -0.4]],
            [[-0.6, 0.82, -1.05], [0.6, 0.82, -1.05], [0.8, 0.85, -0.4], [0.75, 0.8, 0.5], [0.45, 0.55, 1.0], [-0.45, 0.55, 1.0], [-0.8, 0.85, 0.5], [-0.8, 0.85, -0.4]],
          ],
          closeEnds: true,
        },
      }],
    },
    "gun-pivot": {
      schemaVersion: 1,
      semanticId: "gun-pivot",
      kind: "group",
      parentSemanticId: "turret-pivot",
      origin: [0, 0.42, 0.95],
      parts: [],
    },
    gun: {
      schemaVersion: 1,
      semanticId: "gun",
      parentSemanticId: "gun-pivot",
      material,
      parts: [{ name: "barrel", geometry: { kind: "tube", from: [0, 0, 0], to: [0, 0, 3.2], radius: 0.11, segments: 8 } }],
    },
    "track-left": {
      schemaVersion: 1,
      semanticId: "track-left",
      origin: [1.82, 0.58, 0],
      material,
      parts: [{ name: "course", geometry: { kind: "box", size: [0.24, 0.9, 5.6] } }],
    },
    "track-right": {
      schemaVersion: 1,
      semanticId: "track-right",
      origin: [-1.82, 0.58, 0],
      material,
      parts: [{ name: "course", geometry: { kind: "box", size: [0.24, 0.9, 5.6] } }],
    },
  };
  for (const side of ["left", "right"] as const) {
    for (let index = 0; index < 5; index += 1) {
      specs[`road-wheel-${side}-${index}`] = {
        schemaVersion: 1,
        semanticId: `road-wheel-${side}-${index}`,
        origin: [(side === "left" ? 1 : -1) * 1.3, 0.5, -2.1 + index * 1.05],
        material,
        parts: [{ name: "wheel", geometry: { kind: "cylinder", radius: 0.5, height: 0.24, segments: 8, axis: "x" } }],
      };
    }
  }
  return specs;
}
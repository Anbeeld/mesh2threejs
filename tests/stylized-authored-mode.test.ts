import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { afterAll, describe, expect, test } from "vitest";
import {
  CONSTRUCTION_MODES,
  DEFAULT_CONSTRUCTION_MODE,
  deriveAllowedIn,
  effectiveConstructionMode,
  isConstructionMode,
  candidateImportViolation,
} from "../src/core/construction-mode.js";
import {
  AUTHOR_SPEC_SCHEMA_VERSION,
  AUTHORED_COMPILER_VERSION,
  authorSpecHash,
  estimateTriangleCount,
  validateAuthorSpec,
  type AuthoredGeometry,
  type AuthorSpec,
} from "../src/core/author-spec.js";
import {
  compileAuthorSpec,
  emitAuthoredModule,
  generateAuthoredRegistrySource,
  MODEL_STYLIZED_SCAFFOLD,
} from "../src/core/author-compiler.js";
import {
  assertNoOracleReachingCandidateFiles,
  compileAuthoredWorkspace,
  orderedAuthoredSemanticsFromBindings,
  validateAuthoredSemanticGraph,
  type AuthoredBinding,
} from "../src/core/authored-candidate.js";
import {
  createAuthoringState,
  freezeAuthoring,
  recordAuthorCheckpoint,
  recordAuthoringValidation,
  recordAuthoringReviewReady,
  recordAuthoringReviewDecision,
  recordAuthoringFinal,
  reopenAuthoring,
} from "../src/core/authoring-state.js";
import { createTaskState, type TaskState } from "../src/core/state.js";
import {
  buildReferenceScene,
  referenceSceneHash,
  verifyReferenceSceneAlignment,
  writeReferenceScene,
  loadReferenceScene,
} from "../src/core/reference-scene.js";
import { computeStyleBinding, parseStyleReferences, type StyleBinding } from "../src/core/style-binding.js";
import { auditOracleCopy } from "../src/core/oracle-copy-audit.js";
import { buildOracleGuides, validateMeasurementNotebook } from "../src/core/oracle-guides.js";
import { sha256 } from "../src/core/hashing.js";
import { snapshotScene } from "../src/core/geometry.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix = "stylized-unit-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// ---------------------------------------------------------------- mode taxonomy (design §5)

describe("construction mode taxonomy", () => {
  test("legacy default is derived-faithful and both modes are recognized", () => {
    expect(DEFAULT_CONSTRUCTION_MODE).toBe("derived-faithful");
    expect([...CONSTRUCTION_MODES].sort()).toEqual(["derived-faithful", "stylized-authored"]);
    expect(isConstructionMode("stylized-authored")).toBe(true);
    expect(isConstructionMode("derived")).toBe(false);
    expect(effectiveConstructionMode(undefined)).toBe("derived-faithful");
    expect(effectiveConstructionMode("stylized-authored")).toBe("stylized-authored");
  });

  test("hard routing: derive only in derived-faithful; authored compile is stylized-only", () => {
    expect(deriveAllowedIn("derived-faithful")).toBe(true);
    expect(deriveAllowedIn("stylized-authored")).toBe(false);
  });

  test("candidate import guard rejects oracle/reference paths", () => {
    expect(candidateImportViolation(".mesh2threejs/oracle/prepared.json")).toBe(".mesh2threejs/oracle");
    expect(candidateImportViolation(".mesh2threejs/reference-view/oracle-scene.json")).toBe(".mesh2threejs/reference-view");
    expect(candidateImportViolation("../refs/style/x.png")).toBe("refs/");
    expect(candidateImportViolation("./.generated/registry.mjs")).toBe(".generated/");
    expect(candidateImportViolation("./.generated-authored/registry.mjs")).toBeNull();
    expect(candidateImportViolation("three")).toBeNull();
    expect(candidateImportViolation("./parts/hull.mjs")).toBeNull();
  });
});

// ---------------------------------------------------------------- AuthorSpec (design §9)

describe("AuthorSpec v1 validation", () => {
  const boxSpec: AuthorSpec = {
    schemaVersion: 1,
    semanticId: "hull",
    origin: [0, 0.5, 0],
    material: { colorSpace: "srgb", color: [0.2, 0.2, 0.2], roughness: 0.8, flatShading: true },
    parts: [{ name: "shell", geometry: { kind: "box", size: [2, 0.5, 1] } }],
  };

  test("accepts the v1 geometry vocabulary", () => {
    const geometries: AuthoredGeometry[] = [
      { kind: "box", size: [1, 1, 1] },
      { kind: "cylinder", radius: 0.2, height: 0.4, segments: 12 },
      { kind: "tube", from: [0, 0, 0], to: [1, 0, 0], radius: 0.05, segments: 8 },
      { kind: "prism", polygon: [[0, 0], [1, 0], [1, 1]], extrude: 0.4 },
      { kind: "loft", rings: [[[0, 0, 0], [1, 0, 0], [1, 1, 0]], [[0, 1, 0], [1, 1, 0], [0.5, 1, 0.5]]], closeEnds: true },
      { kind: "mesh", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
    ];
    for (const geometry of geometries) {
      const spec = { ...boxSpec, parts: [{ name: "part", geometry }] };
      expect(() => validateAuthorSpec(spec)).not.toThrow();
    }
  });

  test("negative: NaN, invalid indices, unknown kind, unknown keys, duplicate parts", () => {
    expect(() => validateAuthorSpec({ ...boxSpec, parts: [{ name: "p", geometry: { kind: "box", size: [Number.NaN, 1, 1] } }] })).toThrow(/finite/);
    expect(() => validateAuthorSpec({ ...boxSpec, parts: [{ name: "p", geometry: { kind: "mesh", positions: [0, 0, 0, 1, 1, 1, 0, 0, 0], indices: [0, 1, 9] } }] })).toThrow(/vertex range/);
    expect(() => validateAuthorSpec({ ...boxSpec, parts: [{ name: "p", geometry: { kind: "lathe", profile: [] } }] })).toThrow(/unknown authored geometry kind/);
    expect(() => validateAuthorSpec({ ...boxSpec, parts: [{ name: "p", geometry: { kind: "box", size: [1, 1, 1] }, evil: "x" }] })).toThrow(/unknown key/);
    expect(() => validateAuthorSpec({ ...boxSpec, parts: [{ name: "p", geometry: { kind: "box", size: [1, 1, 1] } }, { name: "p", geometry: { kind: "box", size: [1, 1, 1] } }] })).toThrow(/duplicate/);
    expect(() => validateAuthorSpec({ ...boxSpec, material: { colorSpace: "linear", color: [0, 0, 0] } })).toThrow(/colorSpace must be "srgb"/);
    expect(() => validateAuthorSpec({ ...boxSpec, semanticId: "HULL!" })).toThrow(/kebab-case/);
  });

  test("negative: executable payload, URLs, and code strings are refused", () => {
    expect(() => validateAuthorSpec({ ...boxSpec, parts: [{ name: "import x from 'fs'", geometry: { kind: "box", size: [1, 1, 1] } }] })).toThrow(/executable|data/i);
    expect(() => validateAuthorSpec({ ...boxSpec, parts: [{ name: "see https://evil.example/payload", geometry: { kind: "box", size: [1, 1, 1] } }] })).toThrow(/URL/);
  });

  test("negative: excessive complexity fails closed", () => {
    const positions: number[] = [];
    const indices: number[] = [];
    const vertexCeiling = 8000;
    for (let index = 0; index < vertexCeiling + 3; index += 1) positions.push(0, 0, 0);
    for (let index = 0; index < vertexCeiling / 3; index += 1) indices.push(0, 1, 2);
    expect(() => validateAuthorSpec({ ...boxSpec, parts: [{ name: "huge", geometry: { kind: "mesh", positions, indices } }] })).toThrow(/ceiling/);
  });

  test("positive/negative loft correspondence (design Q2)", () => {
    const good = { kind: "loft", rings: [[[0, 0, 0], [1, 0, 0], [1, 0, 1]], [[0, 1, 0], [1, 1, 0], [1, 1, 1]]] };
    expect(() => validateAuthorSpec({ ...boxSpec, parts: [{ name: "loft", geometry: good }] })).not.toThrow();
    const bad = { kind: "loft", rings: [[[0, 0, 0], [1, 0, 0], [0.5, 0, 0.5]], [[0, 1, 0], [1, 1, 0], [0.5, 1, 0.5], [0.2, 1, 0.2]]] };
    expect(() => validateAuthorSpec({ ...boxSpec, parts: [{ name: "loft", geometry: bad }] })).toThrow(/equal counts per ring/);
  });

  test("spec hash is content-deterministic", () => {
    expect(authorSpecHash(boxSpec)).toBe(authorSpecHash(structuredClone(boxSpec)));
    expect(authorSpecHash(boxSpec)).not.toBe(authorSpecHash({ ...boxSpec, origin: [0, 0.6, 0] }));
    expect(AUTHOR_SPEC_SCHEMA_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------- author compiler (design §9/§28)

describe("trusted author compiler", () => {
  test("deterministic compilation: identical spec bytes produce identical module bytes and hashes", () => {
    const spec = validateAuthorSpec({
      schemaVersion: 1,
      semanticId: "turret",
      origin: [0, 1.6, 0.5],
      material: { colorSpace: "srgb", color: [0.18, 0.16, 0.07], roughness: 0.8, flatShading: true },
      parts: [
        { name: "cast-shell", geometry: { kind: "loft", rings: [[[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]]] } },
        { name: "mantlet", geometry: { kind: "box", size: [0.3, 0.3, 0.2] }, translate: [0, 0.4, 1.0] },
      ],
    });
    const first = compileAuthorSpec(spec);
    const second = compileAuthorSpec(spec);
    expect(first.geometryHash).toBe(second.geometryHash);
    expect(first.materialHash).toBe(second.materialHash);
    expect(emitAuthoredModule(first)).toBe(emitAuthoredModule(second));
    expect(first.triangleCount).toBe(estimateTriangleCount(spec.parts[0]!.geometry) + estimateTriangleCount(spec.parts[1]!.geometry));
    // sRGB -> linear conversion is deterministic and channel-wise darker for mid tones.
    const linear = first.parts[0]!.material.colorLinear;
    expect(linear[0]).toBeCloseTo(0.0265, 2);
    const module = emitAuthoredModule(first);
    expect(module).toContain(`group.name = "turret"`);
    expect(module).toContain(`mesh.userData.semanticId = "turret"`);
    expect(module).toContain(`createSeed`);
    // Compiler output has no oracle-derived API surface (design D6): no resampling helpers exist.
    expect(module).not.toMatch(/oracle|resample|simplifyOracle|contour/i);
  });

  test("pivot semantics are transform-only groups (design §28.2)", () => {
    const pivot = validateAuthorSpec({ schemaVersion: 1, semanticId: "turret-pivot", kind: "group", origin: [0, 1.6, 0.3], parts: [] });
    const compiled = compileAuthorSpec(pivot);
    expect(compiled.parts.length).toBe(0);
    expect(compiled.triangleCount).toBe(0);
    const specWithParts = { ...pivot, parts: [{ name: "x", geometry: { kind: "box" as const, size: [1, 1, 1] as [number, number, number] } }] };
    expect(() => compileAuthorSpec(specWithParts)).toThrow(/transform-only group/);
  });

  test("authored registry + scaffold are stable and composed from bindings order", () => {
    const ordered = ["turret-pivot", "turret", "hull"];
    const nestings: Array<readonly [string, string]> = [["turret", "turret-pivot"]];
    const source = generateAuthoredRegistrySource(ordered, nestings);
    expect(source).toContain(`import { createSeed as createSeedturretpivot } from "./turret-pivot.mjs";`);
    expect(source).toContain(JSON.stringify(nestings));
    expect(source).toContain("setPose(pose)");
    expect(source).toContain("turret-pivot");
    expect(MODEL_STYLIZED_SCAFFOLD).toContain('.generated-authored/registry.mjs');
  });
});

// ---------------------------------------------------------------- semantic graph + composition (design §10/§28)

describe("authored semantic graph", () => {
  const hull: AuthorSpec = { schemaVersion: 1, semanticId: "hull", parts: [{ name: "shell", geometry: { kind: "box", size: [2, 0.5, 1] } }] };
  const turretPivot: AuthorSpec = { schemaVersion: 1, semanticId: "turret-pivot", kind: "group", origin: [0, 1.6, 0.3], parts: [] };
  const turret: AuthorSpec = { schemaVersion: 1, semanticId: "turret", parentSemanticId: "turret-pivot", parts: [{ name: "shell", geometry: { kind: "box", size: [1, 0.5, 1] } }] };
  const gun: AuthorSpec = { schemaVersion: 1, semanticId: "gun", parentSemanticId: "gun-pivot", parts: [{ name: "barrel", geometry: { kind: "tube", from: [0, 0, 0], to: [1.5, 0, 0], radius: 0.05, segments: 8 } }] };

  test("one root per semantic; parents precede children; external pivot nestings recorded", () => {
    const { ordered, pivotNestings } = validateAuthoredSemanticGraph([turret, turretPivot, hull, gun], new Set(["gun-pivot"]));
    expect(ordered.map((spec) => spec.semanticId)).toEqual(["turret-pivot", "turret", "hull", "gun"]);
    // Every parented semantic nests (authored pivot parents AND external pivots).
    expect(pivotNestings).toEqual([["turret", "turret-pivot"], ["gun", "gun-pivot"]]);
  });

  test("negative: unresolvable external parent fails compile instead of silently unparenting", () => {
    expect(() => validateAuthoredSemanticGraph([hull, gun])).toThrow(/neither an authored semantic root nor a known oracle pivot semantic/u);
    // Declared by the live oracle semantic map -> legal external pivot.
    expect(() => validateAuthoredSemanticGraph([hull, gun], new Set(["gun-pivot"]))).not.toThrow();
  });

  test("negative: duplicate roots and cycles fail closed", () => {
    expect(() => validateAuthoredSemanticGraph([hull, { ...hull }])).toThrow(/duplicate authored semantic root/);
    const a: AuthorSpec = { schemaVersion: 1, semanticId: "a", parentSemanticId: "b", parts: [{ name: "p", geometry: { kind: "box", size: [1, 1, 1] } }] };
    const b: AuthorSpec = { schemaVersion: 1, semanticId: "b", parentSemanticId: "a", parts: [{ name: "p", geometry: { kind: "box", size: [1, 1, 1] } }] };
    expect(() => validateAuthoredSemanticGraph([a, b])).toThrow(/cycle/);
  });

  test("orderedAuthoredSemanticsFromBindings reproduces the registry ordering from durable bindings alone", () => {
    const bindings: Record<string, AuthoredBinding> = {
      "model/.generated-authored/turret.mjs": { semanticId: "turret", authorSpecHash: "0".repeat(64), authoredManifestHash: "0".repeat(64), generatedModuleHash: "0".repeat(64), geometryHash: "0".repeat(64), materialHash: "0".repeat(64), compilerVersion: AUTHORED_COMPILER_VERSION, parentSemanticId: "turret-pivot" },
      "model/.generated-authored/hull.mjs": { semanticId: "hull", parentSemanticId: null } as AuthoredBinding,
      "model/.generated-authored/turret-pivot.mjs": { semanticId: "turret-pivot", parentSemanticId: null } as AuthoredBinding,
    };
    expect(orderedAuthoredSemanticsFromBindings(bindings)).toEqual(["hull", "turret-pivot", "turret"]);
  });

  test("full workspace compilation is deterministic and produces stable bindings", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "model/stylized"), { recursive: true });
    await writeFile(join(root, "model/stylized/hull.json"), JSON.stringify(hull, null, 2));
    await writeFile(join(root, "model/stylized/turret-pivot.json"), JSON.stringify(turretPivot, null, 2));
    await writeFile(join(root, "model/stylized/turret.json"), JSON.stringify(turret, null, 2));
    await writeFile(join(root, "model/stylized/gun.json"), JSON.stringify(gun, null, 2));
    const first = await compileAuthoredWorkspace(root, { knownExternalParents: new Set(["gun-pivot"]) });
    const second = await compileAuthoredWorkspace(root, { knownExternalParents: new Set(["gun-pivot"]) });
    expect(first.compiledGraphHash).toBe(second.compiledGraphHash);
    expect(first.ordered.map((spec) => spec.semanticId)).toEqual(["gun", "hull", "turret-pivot", "turret"]);
    expect(first.registrySource).toContain("turret-pivot.mjs");
    for (const module of first.modules) {
      expect(module.manifest.kind).toBe("mesh2threejs-authored-part");
      expect(module.manifest.compilerVersion).toBe(AUTHORED_COMPILER_VERSION);

    }
    // A mutated spec changes the compiled graph hash.
    await writeFile(join(root, "model/stylized/hull.json"), JSON.stringify({ ...hull, origin: [0, 0.1, 0] }, null, 2));
    const mutated = await compileAuthoredWorkspace(root, { knownExternalParents: new Set(["gun-pivot"]) });
    expect(mutated.compiledGraphHash).not.toBe(first.compiledGraphHash);
  });
});

// ---------------------------------------------------------------- candidate isolation (design §11.3/§16/§33.3)

describe("candidate isolation audit", () => {
  test("candidate files reaching oracle/reference/refs data are refused before execution", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "model/parts"), { recursive: true });
    await writeFile(join(root, "model/model.mjs"), `import { something } from "../.mesh2threejs/oracle/prepared.json";\nexport const x = something;`);
    await expect(assertNoOracleReachingCandidateFiles(root)).rejects.toThrow(/ORACLE_REFERENCE_IMPORT_FORBIDDEN|forbidden reference data/u);
  });

  test("reference-view and refs imports are refused; ordinary local imports pass", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "model"), { recursive: true });
    await writeFile(join(root, "model/model.mjs"), `import { a } from "../.mesh2threejs/reference-view/oracle-scene.json";\nexport const x = a;`);
    await expect(assertNoOracleReachingCandidateFiles(root)).rejects.toThrow(/reference-view/);
    const root2 = await tempRoot();
    await mkdir(join(root2, "model/parts"), { recursive: true });
    await writeFile(join(root2, "model/model.mjs"), `import { a } from "./parts/a.mjs";\nimport * as THREE from "three";\nexport const x = a;`);
    await writeFile(join(root2, "model/parts/a.mjs"), `export const a = 1;`);
    await expect(assertNoOracleReachingCandidateFiles(root2)).resolves.toBeUndefined();
  });

  test("executable files in model/stylized are a hard failure (data-only authoring input)", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "model/stylized"), { recursive: true });
    await writeFile(join(root, "model/stylized/hull.mjs"), `export const evil = 1;`);
    const { assertNoExecutableAuthoredFiles } = await import("../src/core/authored-candidate.js");
    await expect(assertNoExecutableAuthoredFiles(root)).rejects.toThrow(/executable authored modules are not allowed/u);
  });
});

// ---------------------------------------------------------------- ReferenceScene (design §11/§33.4)

describe("oracle ReferenceScene", () => {
  function makeOracle(): THREE.Group {
    const group = new THREE.Group();
    group.name = "prepared-oracle";
    const hull = new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 1).translate(0, 0.25, 0), new THREE.MeshStandardMaterial({ color: 0x777777 }));
    hull.name = "hull";
    hull.userData.semanticId = "hull";
    const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.3, 12).translate(0, 1.6, 0), new THREE.MeshStandardMaterial({ color: 0x555555 }));
    turret.name = "turret";
    turret.userData.semanticId = "turret";
    const pivot = new THREE.Group();
    pivot.name = "turret-pivot";
    pivot.position.set(0, 1.45, 0.3);
    pivot.userData.semanticId = "turret-pivot";
    pivot.add(turret);
    group.add(hull, pivot);
    return group;
  }

  const binding = { identity: "prep-identity-1", sourceHash: "source-hash-1", preparedHash: "prepared-hash-1" };

  test("reference scene reproduces evaluator truth and verifies alignment (§33.4)", () => {
    const oracle = new THREE.Group();
    oracle.name = "oracle";
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.name = "hull";
    mesh.userData.semanticId = "hull";
    oracle.add(mesh);
    const scene = buildReferenceScene(oracle, binding as never);
    const snapshot = snapshotScene(oracle);
    expect(scene.triangleCount).toBe(snapshot.triangleCount);
    expect(scene.components.map((component) => component.semanticId)).toEqual(["hull"]);
    const alignment = verifyReferenceSceneAlignment(scene, oracle);
    expect(alignment.aligned).toBe(true);
  });

  test("stale preparation refuses the cached reference scene (REFERENCE_SCENE_STALE)", async () => {
    const root = await tempRoot();
    const oracle = new THREE.Group();
    oracle.name = "oracle";
    oracle.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
    const scene = buildReferenceScene(oracle, binding as never);
    await writeReferenceScene(root, scene);
    const loaded = await loadReferenceScene(root, { identity: "prep-identity-1", sourceHash: "source-hash-1", preparedHash: "prepared-hash-1" } as never);
    const { referenceSceneHash } = await import("../src/core/reference-scene.js");
    expect(loaded.fileHash).toBe(referenceSceneHash(scene));
    await expect(loadReferenceScene(root, { identity: "prep-identity-2", sourceHash: "source-hash-1", preparedHash: "x" } as never)).rejects.toThrow(/REFERENCE_SCENE_STALE|was generated for preparation/u);
  });
});

// ---------------------------------------------------------------- style binding (design §14/§33.5)

describe("style reference binding", () => {
  async function stylizedWorkspaceRoot(): Promise<{ root: string; referenceIndex: { schemaVersion: 1; records: Array<{ kind: "image"; mode: "copy"; operationalPath: string; originalPath: string; sha256: string }> } }> {
    const root = await tempRoot();
    await mkdir(join(root, "refs/style"), { recursive: true });
    await mkdir(join(root, "style"), { recursive: true });
    await writeFile(join(root, "refs/style/ref-01.png"), Buffer.from("png-bytes-1"));
    const sha = sha256(await readFile(join(root, "refs/style/ref-01.png")));
    const referenceIndex = { schemaVersion: 1 as const, records: [{ kind: "image" as const, mode: "copy" as const, operationalPath: "refs/style/ref-01.png", originalPath: join(root, "refs/style/ref-01.png"), sha256: sha }] };
    await writeFile(join(root, "style/references.json"), JSON.stringify({ schemaVersion: 1, references: [{ path: "refs/style/ref-01.png", role: "primary-style", notes: "abstraction only" }] }, null, 2));
    await writeFile(join(root, "style/brief.md"), "# Style\n\nFaceted, chunky, few material families.\n");
    return { root, referenceIndex };
  }

  test("binding hashes cover references and brief; missing manifest fails STYLE_BINDING_REQUIRED", async () => {
    const { root, referenceIndex } = await stylizedWorkspaceRoot();
    const { computeStyleBinding } = await import("../src/core/style-binding.js");
    const binding = await computeStyleBinding(root, referenceIndex as never);
    expect(binding.styleBindingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(binding.references[0]!.path).toBe("refs/style/ref-01.png");
    // Brief mutation changes the binding hash.
    const before = binding.styleBindingHash;
    await writeFile(join(root, "style/brief.md"), "# Style\n\nChanged.\n");
    const changed = await computeStyleBinding(root, referenceIndex as never);
    expect(changed.styleBindingHash).not.toBe(before);
    // Missing manifest fails closed.
    const { rm: rmFile } = await import("node:fs/promises");
    await rmFile(join(root, "style/references.json"));
    await expect(computeStyleBinding(root, referenceIndex as never)).rejects.toThrow(/STYLE_BINDING_REQUIRED|no style reference manifest/u);
  });

  test("reference byte mutation is detected against the recorded binding", async () => {
    const { root, referenceIndex } = await stylizedWorkspaceRoot();
    await mkdir(join(root, ".mesh2threejs"), { recursive: true });
    await writeFile(join(root, ".mesh2threejs/references.json"), JSON.stringify(referenceIndex));
    const { computeStyleBinding, verifyStyleBindingCurrent } = await import("../src/core/style-binding.js");
    const binding = await computeStyleBinding(root, referenceIndex as never);
    await verifyStyleBindingCurrent(root, binding);
    await writeFile(join(root, "refs/style/ref-01.png"), Buffer.from("tampered"));
    await expect(verifyStyleBindingCurrent(root, binding)).rejects.toThrow(/FREEZE_STALE|style binding changed|bytes changed|re-register/u);
  });
});

// ---------------------------------------------------------------- copy audit (design §16.3/§33.8)

describe("oracle copy contamination audit", () => {
  function snapshotFrom(group: THREE.Object3D) {
    return snapshotScene(group);
  }

  test("copied oracle component is flagged; fresh topology with the same dimensions is clean; shared landmarks are clean", () => {
    const oracle = new THREE.Group();
    oracle.name = "oracle";
    const copied = new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 1).translate(0, 0.25, 0), new THREE.MeshStandardMaterial());
    copied.name = "fender-copy";
    copied.userData.semanticId = "fender-copy";
    oracle.add(copied);
    const oracleSnapshot = snapshotFrom(oracle);

    // Candidate 1: exact copy of the oracle component.
    const candidateCopy = new THREE.Group();
    candidateCopy.name = "candidate";
    const copy = new THREE.Mesh(new THREE.BoxGeometry(2, 0.5, 1).translate(0, 0.25, 0), new THREE.MeshStandardMaterial());
    copy.name = "fender";
    copy.userData.semanticId = "fender";
    candidateCopy.add(copy);
    const copyReport = auditOracleCopy(oracleSnapshot, snapshotFrom(candidateCopy));
    expect(copyReport.status).toBe("warning");
    expect(copyReport.components.find((component) => component.componentId === "fender")!.flagged).toBe(true);
    expect(copyReport.enforcement).toBe("diagnostic-warning");

    // Candidate 2: fresh topology, same macro dimensions -> no copy violation.
    const candidateFresh = new THREE.Group();
    candidateFresh.name = "candidate";
    const freshShape = new THREE.BufferGeometry();
    const freshPositionArray = new Float32Array([
      -1, 0, -0.5, 1, 0, -0.5, 1, 0.5, -0.5, -1, 0, -0.5, 1, 0.5, -0.5, -1, 0.5, -0.5,
      -1, 0, 0.5, 1, 0, 0.5, 1, 0.5, 0.5, -1, 0, 0.5, 1, 0.5, 0.5, -1, 0.5, 0.5,
      -1, 0, -0.5, -1, 0, 0.5, -1, 0.5, 0.5, -1, 0, -0.5, -1, 0.5, 0.5, -1, 0.5, -0.5,
      1, 0, -0.5, 1, 0, 0.5, 1, 0.5, 0.5, 1, 0, -0.5, 1, 0.5, 0.5, 1, 0.5, -0.5,
      -1, 0, -0.5, 1, 0, -0.5, 1, 0, 0.5, -1, 0, -0.5, 1, 0, 0.5, -1, 0, 0.5,
      -1, 0.5, -0.5, 1, 0.5, -0.5, 1, 0.5, 0.5, -1, 0.5, -0.5, 1, 0.5, 0.5, -1, 0.5, 0.5,
    ]);
    freshShape.setAttribute("position", new THREE.BufferAttribute(freshPositionArray, 3));
    freshShape.computeVertexNormals();
    const fresh = new THREE.Mesh(freshShape, new THREE.MeshStandardMaterial());
    fresh.name = "fender";
    fresh.userData.semanticId = "fender";
    candidateFresh.add(fresh);
    const freshReport = auditOracleCopy(oracleSnapshot, snapshotFrom(candidateFresh));
    expect(freshReport.status).toBe("clean");

    // Candidate 3: one intentionally aligned planar triangle + landmark vertices -> no violation.
    const candidateLandmark = new THREE.Group();
    candidateLandmark.name = "candidate";
    const landmarkShape = new THREE.BufferGeometry();
    const landmarkPositions = new Float32Array([
      -1, 0, -0.5, 1, 0, -0.5, 1, 0, 0.5,
      -1, 0, -0.5, 1, 0, 0.5, -1, 0, 0.5,
      -1, 0.25, -0.5, 1, 0.25, -0.5, 1, 0.25, 0.5,
      -1, 0.25, -0.5, 1, 0.25, 0.5, -1, 0.25, 0.5,
    ]);
    landmarkShape.setAttribute("position", new THREE.BufferAttribute(landmarkPositions, 3));
    landmarkShape.computeVertexNormals();
    const landmark = new THREE.Mesh(landmarkShape, new THREE.MeshStandardMaterial());
    landmark.name = "plate";
    landmark.userData.semanticId = "plate";
    candidateLandmark.add(landmark);
    const landmarkReport = auditOracleCopy(oracleSnapshot, snapshotFrom(candidateLandmark));
    expect(landmarkReport.status).toBe("clean");
  });

  test("audit report is content-hashed and quantization is recorded", () => {
    const oracle = new THREE.Group();
    oracle.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
    const report = auditOracleCopy(snapshotFrom(oracle), snapshotFrom(oracle));
    expect(report.reportHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.quantization).toBeGreaterThan(0);
    expect(report.oracleTriangleCount).toBe(report.candidateTriangleCount);
    expect(report.totalMatchedFraction).toBeCloseTo(1, 4);
  });
});

// ---------------------------------------------------------------- measurement guides + notebook (design §12/§13)

describe("oracle measurement guides and notebook", () => {
  test("guides return low-dimensional facts only, never topology", () => {
    const oracle = new THREE.Group();
    oracle.name = "oracle";
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial());
    mesh.name = "hull";
    mesh.userData.semanticId = "hull";
    oracle.add(mesh);
    const snapshot = snapshotScene(oracle);
    const guide = buildOracleGuides(snapshot, "prep-1");
    const hull = guide.semantics.find((semantic) => semantic.semanticId === "hull")!;
    expect(hull.dimensions.length).toBeCloseTo(2, 5);
    expect(hull.dimensions.height).toBeCloseTo(1, 5);
    expect(hull.triangleCount).toBe(12);
    const serialized = JSON.stringify(guide);
    // No vertex buffers: the guide payload is bounded low-dimensional data.
    expect(serialized.length).toBeLessThan(4000);
    expect(serialized).not.toContain("trianglePositions");
  });

  test("notebook validation accepts measurements and rejects vertex/contour lists", () => {
    const notebook = validateMeasurementNotebook({
      schemaVersion: 1,
      kind: "mesh2threejs-measurement-notebook",
      oraclePreparationIdentity: "prep-1",
      measurements: [
        { name: "hull_width", value: 1.87, source: "semantic-bounds" },
        { name: "turret_ring_center", value: [0, 1.58, 0.31], source: "oracle-click", referenceSceneHash: "a".repeat(64) },
      ],
    });
    expect(notebook.measurements.length).toBe(2);
    expect(() => validateMeasurementNotebook({
      schemaVersion: 1,
      kind: "mesh2threejs-measurement-notebook",
      measurements: [{ name: "contour", value: [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]], source: "oracle" }],
    })).toThrow(/vertex or contour lists/);
    expect(() => validateMeasurementNotebook({ schemaVersion: 1, kind: "mesh2threejs-measurement-notebook", measurements: [{ name: "nan", value: Number.NaN, source: "x" }] })).toThrow(/finite/);
    expect(() => validateMeasurementNotebook({ schemaVersion: 1, kind: "wrong", measurements: [] })).toThrow(/kind is invalid/);
  });
});

// ---------------------------------------------------------------- authoring lifecycle (design §7/§19/§25/§33.5-§33.7)

describe("stylized authoring lifecycle", () => {
  const H = "a".repeat(64);
  const freezeBase = {
    candidateHash: H,
    authorSpecHash: H,
    compiledGraphHash: H,
    styleBinding: H,
    oracleBinding: "prep-1",
    featurePlanHash: null,
    compilerVersion: AUTHORED_COMPILER_VERSION,
    finalDraftCheckpointId: "final-draft-1",
    neutralGeometryHash: H,
    articulationBehaviorHash: H,
  };

  function stateWithAuthoring(): TaskState {
    const state = createTaskState({ taskId: "stylized-task", profile: "generic", style: "low-poly-faithful", constructionMode: "stylized-authored" });
    const authoring = createAuthoringState();
    authoring.oracleBinding = "prep-1";
    authoring.styleBinding = {
      schemaVersion: 1,
      kind: "mesh2threejs-style-binding",
      styleReferenceSetHash: H,
      styleBriefHash: H,
      styleBindingHash: H,
      references: [{ path: "refs/style/ref-01.png", sha256: H, role: "primary-style" }],
      briefPath: "style/brief.md",
    };
    return { ...state, authoring };
  }

  test("checkpoints are non-authoritative evidence; freeze requires a final-draft checkpoint bound to the frozen candidate", () => {
    const state = stateWithAuthoring();
    const withBlockout = recordAuthorCheckpoint(state, { kind: "blockout", candidateHash: H, capturesHash: H, assessment: { geometry_vs_oracle: { hull: "PASS" } } });
    expect(withBlockout.authoring!.checkpoints[0]!.id).toBe("blockout-1");
    expect(withBlockout.authoring!.status).toBe("authoring");
    // Freeze without final-draft checkpoint fails.
    expect(() => freezeAuthoring(withBlockout, freezeBase)).toThrow(/VISUAL_CHECKPOINT_REQUIRED|final-draft/u);
    // Checkpoint bound to a DIFFERENT candidate fails freeze.
    const otherCandidate = "b".repeat(64);
    const withFinalDraft = recordAuthorCheckpoint(withBlockout, { kind: "final-draft", candidateHash: otherCandidate, capturesHash: H });
    expect(() => freezeAuthoring(withFinalDraft, freezeBase)).toThrow(/final-draft checkpoint evidence is bound to candidate/u);
    // Matching final-draft checkpoint freezes.
    const matching = recordAuthorCheckpoint(withBlockout, { kind: "final-draft", candidateHash: H, capturesHash: H });
    const frozen = freezeAuthoring(matching, freezeBase);
    expect(frozen.authoring!.status).toBe("frozen");
    expect(frozen.authoring!.freeze!.id).toMatch(/^[a-f0-9]{64}$/);
    // Freeze identity is content-derived: a changed binding changes the id.
    const changedFreeze = freezeAuthoring(matching, { ...freezeBase, styleBinding: "c".repeat(64) });
    expect(changedFreeze.authoring!.freeze!.id).not.toBe(frozen.authoring!.freeze!.id);
  });

  test("compiler version change changes freeze identity (§33.5)", () => {
    const state = stateWithAuthoring();
    const withFinalDraft = recordAuthorCheckpoint(state, { kind: "final-draft", candidateHash: H, capturesHash: H });
    const frozen = freezeAuthoring(withFinalDraft, freezeBase);
    const otherCompiler = freezeAuthoring(withFinalDraft, { ...freezeBase, compilerVersion: "9.9.9" });
    expect(otherCompiler.authoring!.freeze!.id).not.toBe(frozen.authoring!.freeze!.id);
  });

  test("reopen invalidates freeze/validation/review but preserves oracle and style bindings (§33.6)", () => {
    const state = stateWithAuthoring();
    const withFinalDraft = recordAuthorCheckpoint(state, { kind: "final-draft", candidateHash: H, capturesHash: H });
    let current = freezeAuthoring(withFinalDraft, freezeBase);
    const freezeId = current.authoring!.freeze!.id;
    current = recordAuthoringValidation(current, { freezeId, reportHash: H, passed: true });
    expect(current.authoring!.status).toBe("validated");
    current = recordAuthoringReviewReady(current, { freezeId, packetHash: H });
    expect(current.authoring!.status).toBe("visual-review");
    current = recordAuthoringReviewDecision(current, { freezeId, packetHash: H, decision: "approved" });
    expect(current.authoring!.status).toBe("approved");
    // Design §7.1: the failure/edit route is frozen/validated/visual-review — an approved
    // construction reopens by restarting the chain, not by a silent reopen.
    expect(() => reopenAuthoring(current, "late tweak")).toThrow(/cannot reopen authoring from status approved/u);
    const frozenOnce = freezeAuthoring(withFinalDraft, freezeBase);
    const atReview = recordAuthoringReviewReady(
      recordAuthoringValidation(frozenOnce, { freezeId: frozenOnce.authoring!.freeze!.id, reportHash: H, passed: true }),
      { freezeId: frozenOnce.authoring!.freeze!.id, packetHash: "d".repeat(64) },
    );
    const reopened = reopenAuthoring(atReview, "turret silhouette needs rework");
    expect(reopened.authoring!.status).toBe("authoring");
    expect(reopened.authoring!.freeze).toBeUndefined();
    expect(reopened.authoring!.validation).toBeUndefined();
    expect(reopened.authoring!.review).toBeUndefined();
    expect(reopened.authoring!.oracleBinding).toBe("prep-1");
    expect(reopened.authoring!.styleBinding).not.toBeNull();
    // Finalization without approval and validation without freeze fail closed.
    expect(() => recordAuthoringFinalHelper(reopened, freezeId)).toThrow();
    expect(() => recordAuthoringValidation(stateWithAuthoring(), { freezeId, reportHash: H, passed: true })).toThrow(/frozen construction/);
  });

  test("builder cannot bypass freeze: edits after freeze are refused (AUTHORING_FROZEN)", () => {
    const state = stateWithAuthoring();
    const withFinalDraft = recordAuthorCheckpoint(state, { kind: "final-draft", candidateHash: H, capturesHash: H });
    const frozen = freezeAuthoring(withFinalDraft, freezeBase);
    expect(() => recordAuthorCheckpoint(frozen, { kind: "blockout", candidateHash: H, capturesHash: H })).toThrow(/mutable authoring only|AUTHORING_FROZEN/u);
  });

  test("style-binding-free authoring cannot freeze (STYLE_BINDING_REQUIRED, bundle D)", () => {
    const state = createTaskState({ taskId: "t", profile: "generic", style: "low-poly-faithful", constructionMode: "stylized-authored" });
    const authoring = createAuthoringState();
    authoring.oracleBinding = "prep-1";
    const noStyle = { ...state, authoring };
    const withFinalDraft = recordAuthorCheckpoint(noStyle, { kind: "final-draft", candidateHash: H, capturesHash: H });
    expect(() => freezeAuthoring(withFinalDraft, freezeBase)).toThrow(/STYLE_BINDING_REQUIRED|missing style binding/u);
  });
});

function recordAuthoringFinalHelper(state: TaskState, freezeId: string): unknown {
  return recordAuthoringFinal(state, { freezeId });
}
import * as THREE from "three";
import { describe, expect, test } from "vitest";
import {
  captureSemanticTransforms,
  checkArticulation,
  checkAttachments,
  compareMasks,
  fingerprintScene,
  measureBounds,
  measureSection,
  rasterizeCapture,
  silhouetteCurves,
  snapshotScene,
  standardRenderProfile,
} from "../src/index.js";
import { createGenericFixture } from "./helpers/scenes.js";

describe("live scene geometry", () => {
  test("measures transformed world-space bounds", () => {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
    mesh.position.set(3, 4, 5);
    mesh.scale.set(2, 0.5, 1);
    root.add(mesh);
    const bounds = measureBounds(snapshotScene(root));
    expect(bounds.min).toEqual([1, 3, 2]);
    expect(bounds.max).toEqual([5, 5, 8]);
    expect(bounds.size).toEqual([4, 2, 6]);
  });

  test("extracts an actionable cross-section envelope", () => {
    const snapshot = snapshotScene(new THREE.Mesh(new THREE.BoxGeometry(4, 2, 6)));
    const section = measureSection(snapshot, { axis: "z", position: 1, thickness: 0.01 });
    expect(section.sampleCount).toBeGreaterThan(0);
    expect(section.size[0]).toBeCloseTo(4, 5);
    expect(section.size[1]).toBeCloseTo(2, 5);
  });

  test("creates deterministic masks and bidirectional coverage", () => {
    const oracle = snapshotScene(createGenericFixture());
    const candidate = snapshotScene(createGenericFixture({ depth: 2 }));
    const camera = { id: "side", projection: "orthographic" as const, position: [8, 3, 0] as const, target: [0, 0, 0] as const };
    const a = rasterizeCapture(oracle, standardRenderProfile({ width: 96, height: 96 }), camera, "alpha-silhouette");
    const a2 = rasterizeCapture(oracle, standardRenderProfile({ width: 96, height: 96 }), camera, "alpha-silhouette");
    const b = rasterizeCapture(candidate, standardRenderProfile({ width: 96, height: 96 }), camera, "alpha-silhouette");
    expect(a.data).toEqual(a2.data);
    const comparison = compareMasks(a, b);
    expect(comparison.iou).toBeLessThan(1);
    expect(comparison.missingRatio + comparison.excessRatio).toBeGreaterThan(0);
    const curves = silhouetteCurves(a);
    expect(curves.columns.some((column) => column !== null)).toBe(true);
  });

  test("detects detached attachments", () => {
    const attached = checkAttachments(snapshotScene(createGenericFixture()), [
      { child: "attachment", parent: "primary", maxGap: 0.01 },
    ]);
    const detached = checkAttachments(snapshotScene(createGenericFixture({ detached: true })), [
      { child: "attachment", parent: "primary", maxGap: 0.01 },
    ]);
    expect(attached[0]?.passed).toBe(true);
    expect(detached[0]?.passed).toBe(false);
  });

  test("checks articulation ownership from live transforms", () => {
    const root = new THREE.Group();
    const hull = new THREE.Group();
    hull.userData.semanticId = "hull";
    const pivot = new THREE.Group();
    pivot.userData.semanticId = "turret";
    const fitting = new THREE.Group();
    fitting.userData.semanticId = "cupola";
    pivot.add(fitting);
    root.add(hull, pivot);
    const before = captureSemanticTransforms(root);
    pivot.rotation.y = Math.PI / 4;
    pivot.updateMatrixWorld(true);
    const after = captureSemanticTransforms(root);
    const result = checkArticulation(before, after, {
      moving: ["turret", "cupola"],
      stationary: ["hull"],
      epsilon: 1e-8,
    });
    expect(result.passed).toBe(true);
  });

  test("fingerprints geometry and structural metadata deterministically", () => {
    const root = createGenericFixture();
    const first = fingerprintScene(root);
    expect(fingerprintScene(root)).toBe(first);
    root.getObjectByName("attachment")?.position.setX(3);
    expect(fingerprintScene(root)).not.toBe(first);
  });
});

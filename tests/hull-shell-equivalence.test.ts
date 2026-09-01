import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { snapshotScene } from "../src/index.js";
import { hullSectionsRow } from "../src/profiles/tank.js";
import type { SceneSnapshot } from "../src/types.js";

/**
 * Freezes the hull-equivalence question (corrected-plan audit item 4): a dense multi-shell
 * oracle (outer armor shell + nested interior shell, the CAD-plate pattern) and a clean
 * watertight solid with the SAME external armor boundary must produce equivalent
 * hull.sections results, because both describe the same exterior macro cross-section.
 *
 * Current even-odd parity filling encodes the nested-shell topology (a hollow ring fill) in
 * the occupancy mask, so the clean solid disagrees with the dense oracle everywhere the
 * interior cavity exists. This test documents that behavior: if it fails today, the evidence
 * supports moving hull.sections to an exterior-boundary metric.
 */

function boxMesh(w: number, h: number, d: number, id: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: 0x6b7358 }));
  mesh.name = id;
  mesh.userData.semanticId = id;
  return mesh;
}

function tankScene(parts: THREE.Mesh[]): THREE.Group {
  const root = new THREE.Group();
  root.name = "tank";
  for (const part of parts) root.add(part);
  return root;
}

function asSnapshot(group: THREE.Group): SceneSnapshot {
  return snapshotScene(group) as unknown as SceneSnapshot;
}

describe("hull.sections shell-topology equivalence (audit item 4)", () => {
  it("dense nested-shell oracle vs clean watertight solid with the same external boundary", () => {
    // Dense oracle: outer 4x1.5x6 shell (as a real watertight box) PLUS a nested interior
    // 3.6x1.1x5.6 shell, mimicking a CAD model with an interior cavity and overlapping plates.
    const dense = tankScene([
      boxMesh(4, 1.5, 6, "hull"),
      boxMesh(3.6, 1.1, 5.6, "hull-interior"),
    ]);
    // Clean candidate: one watertight solid with the same external boundary.
    const clean = tankScene([boxMesh(4, 1.5, 6, "hull")]);
    const oracle = asSnapshot(dense);
    const candidate = asSnapshot(clean);
    const row = hullSectionsRow(oracle, candidate);
    // Exterior-boundary metric: both scenes describe the same external armor boundary, so the
    // nested interior shell must no longer influence the section mask (the pre-fix even-odd
    // parity fill failed this equivalence).
    expect(row.passed).toBe(true);
  });

  it("a box with the wrong external boundary still fails against the dense oracle", () => {
    const dense = tankScene([
      boxMesh(4, 1.5, 6, "hull"),
      boxMesh(3.6, 1.1, 5.6, "hull-interior"),
    ]);
    // Wrong-shape candidate: a tall box with vertical upper sides (no glacis taper) and the
    // wrong footprint. The evaluator must remain discriminative.
    const wrong = tankScene([boxMesh(3.2, 2.4, 5.2, "hull")]);
    const oracle = asSnapshot(dense);
    const candidate = asSnapshot(wrong);
    const row = hullSectionsRow(oracle, candidate);
    expect(row.passed).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { measureSectionSegments, sectionContourFromSegments } from "../src/core/measurement.js";
import { snapshotScene } from "../src/index.js";
import * as THREE from "three";
import type { SceneSnapshot } from "../src/types.js";

/** Two overlapping solid boxes sharing the section plane, consistently oriented outward. */
function overlappingPlatesSnapshot(): SceneSnapshot {
  const a = new THREE.BoxGeometry(1, 1, 1); a.translate(-0.25, 0, 0);
  const b = new THREE.BoxGeometry(1, 1, 1); b.translate(0.25, 0, 0);
  const merged = new THREE.BufferGeometry();
  const pa = a.toNonIndexed().getAttribute("position") as THREE.BufferAttribute;
  const pb = b.toNonIndexed().getAttribute("position") as THREE.BufferAttribute;
  const all = new Float32Array(pa.array.length + pb.array.length);
  all.set(pa.array as Float32Array, 0); all.set(pb.array as Float32Array, pa.array.length);
  merged.setAttribute("position", new THREE.BufferAttribute(all, 3));
  merged.computeVertexNormals();
  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial());
  mesh.name = "hull"; mesh.userData.semanticId = "hull";
  const root = new THREE.Group(); root.name = "tank"; root.add(mesh);
  return snapshotScene(root) as unknown as SceneSnapshot;
}

/** One outer box with an inward-oriented inner box (a walled cavity), like a shelled solid. */
function cavityShellSnapshot(): SceneSnapshot {
  const outer = new THREE.BoxGeometry(1, 1, 1);
  const inner = new THREE.BoxGeometry(0.6, 0.6, 0.6);
  // Flip the inner shell's winding so it faces into the cavity (outward = inward of solid).
  const idx = inner.getIndex()!;
  const flipped = inner.clone();
  const arr = flipped.getIndex()!.array as ArrayLike<number>;
  const swapped: number[] = [];
  for (let t = 0; t < arr.length; t += 3) { swapped.push(arr[t]!, arr[t + 2]!, arr[t + 1]!); }
  flipped.setIndex(swapped);
  void idx;
  const merged = new THREE.BufferGeometry();
  const po = outer.toNonIndexed().getAttribute("position") as THREE.BufferAttribute;
  const pi = flipped.toNonIndexed().getAttribute("position") as THREE.BufferAttribute;
  const all = new Float32Array(po.array.length + pi.array.length);
  all.set(po.array as Float32Array, 0); all.set(pi.array as Float32Array, po.array.length);
  merged.setAttribute("position", new THREE.BufferAttribute(all, 3));
  merged.computeVertexNormals();
  const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial());
  mesh.name = "hull"; mesh.userData.semanticId = "hull";
  const root = new THREE.Group(); root.name = "tank"; root.add(mesh);
  return snapshotScene(root) as unknown as SceneSnapshot;
}

function filledFraction(contour: { mask: Uint8Array }): number {
  return contour.mask.reduce((sum, value) => sum + value, 0) / contour.mask.length;
}

describe("section fill rules at segment level (audit item 3)", () => {
  it("winding fill keeps overlapping plate material filled where even-odd destroys it", () => {
    const snapshot = overlappingPlatesSnapshot();
    // Section through y=0: both boxes cross the plane; their cross-sections overlap on x in
    // [-0.25, 0.25]. Union width = 2.0; parity cancels the overlap band, winding keeps it.
    const segments = measureSectionSegments(snapshot, { axis: "y", position: 0, semanticIds: ["hull"] });
    expect(segments.length).toBeGreaterThan(0);
    const evenOdd = sectionContourFromSegments(segments, 96, "even-odd")!;
    const winding = sectionContourFromSegments(segments, 96, "winding")!;
    expect(filledFraction(winding)).toBeGreaterThan(filledFraction(evenOdd) * 1.15);
    // Winding mask spans the full union width (every column carries fill); parity cannot.
    const activeColumns = Array.from({ length: winding.width }, (_, c): number => {
      for (let r = 0; r < winding.height; r++) if (winding.mask[r * winding.width + c] === 1) return 1;
      return 0;
    }).reduce((a, b) => a + b, 0);
    expect(activeColumns).toBeGreaterThan(winding.width * 0.9);
  });

  it("winding fill keeps a properly oriented interior cavity empty", () => {
    const snapshot = cavityShellSnapshot();
    const segments = measureSectionSegments(snapshot, { axis: "y", position: 0, semanticIds: ["hull"] });
    const winding = sectionContourFromSegments(segments, 96, "winding")!;
    const evenOdd = sectionContourFromSegments(segments, 96, "even-odd")!;
    // Both rules agree for a consistently oriented shelled solid: the cavity stays empty.
    expect(Math.abs(filledFraction(winding) - filledFraction(evenOdd))).toBeLessThan(0.05);
    // Solid fraction = 1 - (0.6/1)^2 = 0.64 for the square ring cross-section.
    expect(filledFraction(winding)).toBeGreaterThan(0.5);
    expect(filledFraction(winding)).toBeLessThan(0.8);
  });
});

import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { countConnectedIslands, createLoftGeometry, measureLandmarks, snapshotScene } from "../src/index.js";

function semanticMesh(id: string, geometry: THREE.BufferGeometry): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry);
  mesh.userData.semanticId = id;
  return mesh;
}

describe("landmark and connectivity operators", () => {
  test("reports exact extrema and repeated component centers", () => {
    const root = new THREE.Group();
    const a = semanticMesh("bolt-0", new THREE.BoxGeometry(1, 1, 1));
    const b = semanticMesh("bolt-1", new THREE.BoxGeometry(1, 1, 1));
    a.position.x = -2;
    b.position.x = 2;
    root.add(a, b);
    const landmarks = measureLandmarks(snapshotScene(root), { semanticPattern: /^bolt-/, axis: "x" });
    expect(landmarks.minimum).toBeCloseTo(-2.5);
    expect(landmarks.maximum).toBeCloseTo(2.5);
    expect(landmarks.centers.map((point) => point[0])).toEqual([-2, 2]);
  });

  test("detects disconnected islands inside one semantic mass", () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      5, 0, 0, 6, 0, 0, 5, 1, 0,
    ], 3));
    const root = semanticMesh("split", geometry);
    expect(countConnectedIslands(snapshotScene(root), "split")).toBe(2);
  });
});

describe("procedural hard-surface kit", () => {
  test("creates a closed, indexed loft with predictable stations", () => {
    const geometry = createLoftGeometry([
      { z: -2, halfWidth: 1, bottom: 0, top: 1 },
      { z: 0, halfWidth: 1.5, bottom: 0, top: 1.5 },
      { z: 2, halfWidth: 1, bottom: 0, top: 1 },
    ]);
    expect(geometry.index?.count).toBe(60);
    expect(geometry.getAttribute("position").count).toBe(12);
    expect(geometry.boundingBox?.min.z).toBe(-2);
    expect(geometry.boundingBox?.max.z).toBe(2);
  });
});

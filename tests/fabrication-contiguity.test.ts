import * as THREE from "three";
import { describe, expect, test } from "vitest";
import { countConnectedIslands } from "../src/core/measurement.js";
import { evaluateTankProfile, snapshotScene } from "../src/index.js";
import type { SceneSnapshot } from "../src/types.js";

/**
 * Bundle A4 regression (pipeline remediation plan §5.A4): tank fabrication must check
 * explicit canonical major masses (hull, turret) — not every semantic whose id starts
 * with "hull". Legitimate multi-part auxiliary hull semantics (fenders) that hull
 * contiguity already validates oracle-relative must not be forced into artificial
 * single-island stitches (evidence E7; the T-34 "handle" workaround).
 */

const material = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: 0x6b7358, roughness: 0.7, flatShading: true });

function semanticMesh(id: string, geometry: THREE.BufferGeometry, position: [number, number, number], rotation?: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material());
  mesh.name = id;
  mesh.userData.semanticId = id;
  mesh.userData.critical = id === "hull" || id === "turret";
  if (rotation) mesh.rotation.set(...rotation);
  mesh.position.set(...position);
  return mesh;
}

/** One semantic group owning TWO legitimate disconnected watertight fender pieces (unnamed children). */
function fenderGroup(id: string, geometry: THREE.BufferGeometry, positions: Array<[number, number, number]>): THREE.Group {
  const group = new THREE.Group();
  group.name = id;
  group.userData.semanticId = id;
  for (const position of positions) {
    const piece = new THREE.Mesh(geometry, material());
    piece.name = `${id}-piece`;
    piece.position.set(...position);
    group.add(piece);
  }
  return group;
}

const hullBox = (): THREE.BufferGeometry => new THREE.BoxGeometry(3.2, 1.2, 6);
const fenderBox = (): THREE.BufferGeometry => new THREE.BoxGeometry(0.4, 0.1, 2.2);
const FENDER_POSITIONS: Array<[number, number, number]> = [[-1.9, 1.15, 0.4], [1.9, 1.15, 0.4]];

interface SceneSpec {
  /** Single hull geometry, or multipart pieces under the single "hull" semantic group. */
  hull?: THREE.BufferGeometry | Array<{ geometry: THREE.BufferGeometry; position: [number, number, number] }>;
  fenders?: boolean;
  turret?: boolean;
  extraHullPiece?: { geometry: THREE.BufferGeometry; position: [number, number, number] };
}

function buildScene(spec: SceneSpec, rootName: string): THREE.Group {
  const root = new THREE.Group();
  root.name = rootName;
  root.userData.forwardAxis = "+z";
  if (Array.isArray(spec.hull)) {
    const group = new THREE.Group();
    group.name = "hull";
    group.userData.semanticId = "hull";
    for (const part of spec.hull) {
      const piece = new THREE.Mesh(part.geometry, material());
      piece.position.set(...part.position);
      group.add(piece);
    }
    root.add(group);
  } else if (spec.hull) {
    root.add(semanticMesh("hull", spec.hull, [0, 0.4, 0]));
  }
  if (spec.fenders) root.add(fenderGroup("hull-fenders", fenderBox(), FENDER_POSITIONS));
  if (spec.turret) {
    const pivot = new THREE.Group();
    pivot.name = "turret-pivot";
    pivot.userData.semanticId = "turret-pivot";
    pivot.position.set(0, 1.8, -0.25);
    pivot.add(semanticMesh("turret", new THREE.CylinderGeometry(1.15, 1.3, 0.9, 12).toNonIndexed(), [0, 0, 0], [Math.PI / 2, 0, 0]));
    root.add(pivot);
  }
  if (spec.extraHullPiece) root.add(semanticMesh("hull-pod", spec.extraHullPiece.geometry, spec.extraHullPiece.position));
  return root;
}

const profileRow = (candidate: SceneSnapshot, code: string, phase: string, oracle?: SceneSnapshot): { passed?: boolean | undefined; message?: string | undefined } => {
  const report = evaluateTankProfile(oracle ?? candidate, candidate, { certification: "oracle-relative", phases: new Set([phase]) });
  const found = report.rows.find((item) => item.code === code);
  return { passed: found?.passed, message: found?.message };
};

describe("fabrication honors explicit major masses; auxiliary hull pieces stay legal (A4)", () => {
  test("multipart fender semantic passes contiguity AND fabrication without any bridge", () => {
    const oracle = snapshotScene(buildScene({ hull: hullBox(), fenders: true }, "fabrication-oracle"));
    // Derived-representation candidate: the simplified fender semantic is ONE mesh whose
    // geometry keeps both disconnected watertight islands.
    const candidate = snapshotScene(buildScene({ hull: hullBox(), fenders: true, turret: true }, "fabrication-candidate"));

    expect(profileRow(oracle, "hull.contiguity", "hull").passed, "oracle self-contiguity with multipart fenders").toBe(true);
    const contiguity = profileRow(candidate, "hull.contiguity", "hull", oracle);
    expect(contiguity.passed, `candidate contiguity with multipart fenders: ${contiguity.message}`).toBe(true);
    const fabrication = profileRow(candidate, "fabrication.profile", "style-fabrication");
    expect(fabrication.passed, `fabrication must not demand fender stitches: ${fabrication.message}`).toBe(true);

    // The fender semantic really is multi-island — proving the pass is not accidental.
    expect(countConnectedIslands(candidate, "hull-fenders")).toBe(2);
  });

  test("negative: split canonical hull into two unexplained major islands fails fabrication", () => {
    const candidate = snapshotScene(buildScene({
      hull: [{ geometry: new THREE.BoxGeometry(3.2, 1.2, 3), position: [0, 0.4, -1.55] }, { geometry: new THREE.BoxGeometry(3.2, 1.2, 3), position: [0, 0.4, 1.55] }],
      turret: true,
    }, "split-hull"));
    expect(countConnectedIslands(candidate, "hull")).toBe(2);
    const fabrication = profileRow(candidate, "fabrication.profile", "style-fabrication");
    expect(fabrication.passed).toBe(false);
    expect(fabrication.message).toMatch(/disconnected/i);
  });

  test("negative: open canonical hull boundary fails fabrication", () => {
    const candidate = snapshotScene(buildScene({ hull: new THREE.PlaneGeometry(3.2, 6), turret: true }, "open-hull"));
    expect(profileRow(candidate, "fabrication.profile", "style-fabrication").passed).toBe(false);
  });

  test("negative: detached extra significant hull piece with no oracle counterpart fails contiguity", () => {
    const oracle = snapshotScene(buildScene({ hull: hullBox(), fenders: true }, "floater-oracle"));
    const candidateRoot = buildScene({ hull: hullBox(), fenders: true }, "floater-candidate");
    candidateRoot.add(semanticMesh("hull-pod", new THREE.BoxGeometry(0.9, 0.6, 0.9), [4.2, 3, -2.4]));
    const candidate = snapshotScene(candidateRoot);
    const report = evaluateTankProfile(oracle, candidate, { certification: "oracle-relative", phases: new Set(["hull"]) });
    expect(report.rows.find((item) => item.code === "hull.contiguity")?.passed).toBe(false);
  });

  test("canonical turret stays fabrication-checked (watertight, single island)", () => {
    const openTurret = buildScene({ hull: hullBox(), turret: true }, "open-turret");
    const turretMesh = openTurret.getObjectByName("turret") as THREE.Mesh;
    // Open-ended cylinder: boundary edges on the canonical major mass.
    turretMesh.geometry = new THREE.CylinderGeometry(1.15, 1.3, 0.9, 12, 1, true).toNonIndexed();
    const candidate = snapshotScene(openTurret);
    const fabrication = profileRow(candidate, "fabrication.profile", "style-fabrication");
    expect(fabrication.passed, `open canonical turret must fail fabrication: ${fabrication.message}`).toBe(false);
  });
});

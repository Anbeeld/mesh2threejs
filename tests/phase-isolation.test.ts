import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/index.js";
import { createSlopedTank, sceneToGlb, stableSemanticIdentityMap } from "./helpers/tank-fixtures.js";

function sink() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value) } };
}

async function initializeTankWorkspace(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-hull-gate-"));
  const root = join(parent, "workspace");
  const source = join(parent, "source.glb");
  await writeFile(source, sceneToGlb(createSlopedTank()));
  const first = sink();
  expect(await runCli(["init", root, "--id", "hull-gate", "--goal", "hull-only pipeline", "--profile", "tank", "--oracle", source], first.io)).toBe(0);
  const onboard = join(parent, "onboard.json");
  await writeFile(onboard, JSON.stringify({
    id: "hull-gate", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
    coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
    semanticMap: stableSemanticIdentityMap(createSlopedTank()),
    articulationMap: { gun: "gun-pivot", turret: "turret-pivot" },
    normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
    authoritativeDimensions: null, dimensionSources: [],
  }));
  expect(await runCli(["onboard", root, "--config", onboard], first.io)).toBe(0);
  expect(await runCli(["oracle-sanity", root], first.io)).toBe(0);
  const registration = join(parent, "registration.json");
  await writeFile(registration, JSON.stringify({ forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, tolerance: 0.02, requiredSemantics: ["hull", "turret", "gun"], requiredPivots: ["turret-pivot", "gun-pivot"] }));
  expect(await runCli(["register", root, "--config", registration], first.io)).toBe(0);
  expect(await runCli(["lock", root], first.io)).toBe(0);
  return root;
}

async function hullOnlyCandidateSource(): Promise<string> {
  const tank = createSlopedTank();
  const hull = tank.getObjectByName("hull") as unknown as { geometry: { toNonIndexed: () => { getAttribute: (name: string) => { array: Float32Array } } } };
  const values = Array.from(hull.geometry.toNonIndexed().getAttribute("position").array as Float32Array);
  return `import * as THREE from "three";
export function createCandidate() {
  const root = new THREE.Group();
  root.name = "hull-only-candidate";
  root.userData.forwardAxis = "+z";
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([${values.join(",")}]), 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: new THREE.Color(0.42, 0.45, 0.35), roughness: 0.7 }));
  mesh.name = "hull";
  mesh.userData.semanticId = "hull";
  root.add(mesh);
  return root;
}
`;
}

describe("active-phase execution through the workspace CLI", () => {
  test("a plain hull-only Group without setPose gates during the hull phase with no future evidence", async () => {
    const root = await initializeTankWorkspace();
    await writeFile(join(root, "model", "model.mjs"), await hullOnlyCandidateSource());
    const out = sink();
    expect(await runCli(["gate", root], out.io)).toBe(0);
    expect(out.stderr).toEqual([]);
    const report = JSON.parse(out.stdout.join("")) as {
      activePhase: string;
      passed: boolean;
      deterministic: { rows: Array<{ code: string; phase?: string }> };
      note?: string;
      globalPassed?: boolean;
      style?: unknown;
      articulation?: unknown;
    };
    expect(report.activePhase).toBe("hull");
    expect(report.passed).toBe(true);
    expect(report.note).toMatch(/active-phase/i);
    // No future-phase or global diagnostics may leak into the normal stream.
    expect(report.globalPassed).toBeUndefined();
    expect(report.style).toBeUndefined();
    expect(report.articulation).toBeUndefined();
    const codes = report.deterministic.rows.map((row) => row.code);
    expect(codes).toContain("curves.hull");
    expect(codes).toContain("hull.sections");
    expect(codes.some((code) => /^(turret|gun|running-gear|track|style|fabrication|articulation)/u.test(code))).toBe(false);

    const runDirectory = join(root, ".mesh2threejs", "evidence", "gate-0001");
    const artifacts = await readdir(runDirectory);
    expect(artifacts).toEqual(["gate-0001-hull.json"]);

    // The explicit complete evaluation requires physical articulation controls, so it refuses
    // a control-less partial candidate instead of silently skipping future phases.
    const globalRun = sink();
    const globalExit = await runCli(["gate", root, "--global"], globalRun.io);
    expect(globalExit).not.toBe(0);
    expect([...globalRun.stderr, ...globalRun.stdout].join("")).toMatch(/articulation/i);
  }, 60_000);

  test("registration locking requires the oracle sanity board for tank projects", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-sanity-req-"));
    const root = join(parent, "workspace");
    const source = join(parent, "source.glb");
    await writeFile(source, sceneToGlb(createSlopedTank()));
    const out = sink();
    expect(await runCli(["init", root, "--id", "sanity-req", "--goal", "sanity gating", "--profile", "tank", "--oracle", source], out.io)).toBe(0);
    const onboard = join(parent, "onboard.json");
    await writeFile(onboard, JSON.stringify({
      id: "sanity-req", sourcePath: "ignored", preparedPath: "ignored", source: "fixture", author: "fixture", license: "MIT", redistribution: "allowed",
      coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
      semanticMap: stableSemanticIdentityMap(createSlopedTank()),
      articulationMap: { gun: "gun-pivot", turret: "turret-pivot" },
      normalization: { translation: [0, 0, 0], rotationEuler: [0, 0, 0], scale: 1 },
      authoritativeDimensions: null, dimensionSources: [],
    }));
    expect(await runCli(["onboard", root, "--config", onboard], out.io)).toBe(0);
    const registration = join(parent, "registration.json");
    await writeFile(registration, JSON.stringify({ forwardAxis: "+z", upAxis: "+y", expectedScale: 1, groundY: 0, tolerance: 0.02, requiredSemantics: [], requiredPivots: [] }));
    expect(await runCli(["register", root, "--config", registration], out.io)).toBe(0);
    // Without a sanity capture the lock must fail closed; a board captured for an EARLIER
    // preparation is equally unacceptable; only a fresh board for the live preparation locks.
    const blocked = sink();
    expect(await runCli(["lock", root], blocked.io)).not.toBe(0);
    expect(await runCli(["oracle-sanity", root], out.io)).toBe(0);
    await writeFile(join(root, "repair.json"), JSON.stringify({ reason: "re-emit preparation to invalidate stale sanity evidence" }));
    expect(await runCli(["repair-oracle", root, "--config", join(root, "repair.json")], out.io)).toBe(0);
    const stale = sink();
    const staleExit = await runCli(["lock", root], stale.io);
    expect(staleExit).not.toBe(0);
    expect([...stale.stderr, ...stale.stdout].join("")).toMatch(/different oracle preparation/i);
    expect(await runCli(["oracle-sanity", root], out.io)).toBe(0);
    // Repair invalidated prior registration evidence; re-register for the new preparation.
    expect(await runCli(["register", root, "--config", registration], out.io)).toBe(0);
    const sanityManifestPath = join(root, ".mesh2threejs", "captures", "oracle-sanity-0001", "oracle-sanity-manifest.json");
    const sanityManifest = JSON.parse(await readFile(sanityManifestPath, "utf8")) as { views: string[]; canonicalFrame: Record<string, string> };
    expect(sanityManifest.views).toEqual(expect.arrayContaining(["front", "rear", "left-side", "right-side", "top", "perspective"]));
    expect(sanityManifest.canonicalFrame.forward).toBe("+Z");
    expect(await runCli(["lock", root], sink().io)).toBe(0);
  }, 60_000);
});

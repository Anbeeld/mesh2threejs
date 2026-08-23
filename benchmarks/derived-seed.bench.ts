import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as THREE from "three";
import { createLoftGeometry } from "../src/kit.js";
import { sceneToGlb, tessellateFiner, stableSemanticIdentityMap } from "../tests/helpers/tank-fixtures.js";
import { createWorkspaceResolver, initializeWorkspace, loadTaskState } from "../src/index.js";
import { runCli } from "../src/cli.js";

function semanticMesh(id: string, geometry: THREE.BufferGeometry, position: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x6b7358 }));
  mesh.name = id; mesh.userData.semanticId = id; mesh.position.set(...position); return mesh;
}

const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-bench-derive-"));
const root = join(parent, "workspace");
const stations = [
  { z: -3.0, halfWidth: 1.15, bottom: 0.55, top: 1.05 },
  { z: -2.2, halfWidth: 1.45, bottom: 0.5, top: 1.45 },
  { z: -0.4, halfWidth: 1.55, bottom: 0.5, top: 1.6 },
  { z: 1.6, halfWidth: 1.5, bottom: 0.5, top: 1.5 },
  { z: 2.9, halfWidth: 1.25, bottom: 0.5, top: 1.05 },
];
// Source fixture lives OUTSIDE the workspace and is passed to init explicitly — the same
// supported entry path as a real user; post-init placement would not enter the reference index.
const fixturePath = join(parent, "dense-hull.glb");
const fixture = new THREE.Group();
fixture.add(semanticMesh("hull", tessellateFiner(createLoftGeometry(stations), 6), [0, 0, 0]));
fixture.add(semanticMesh("hull-fender", new THREE.BoxGeometry(0.35, 0.08, 2.2).toNonIndexed(), [1.45, 0.95, 0.2]));
const identity = new Map<string, string>();
for (const [k, name] of Object.entries(stableSemanticIdentityMap(fixture))) if (!identity.has(name)) identity.set(name, k);
const semanticMap = Object.fromEntries([...identity].map(([name, key]) => [key, name]));
await writeFile(fixturePath, sceneToGlb(fixture));
const beforeRss = process.memoryUsage().rss;
const start = performance.now();
await initializeWorkspace(root, { id: "bench-derive", goal: "bench", profile: "tank", oracle: fixturePath });
const resolver = createWorkspaceResolver(root);
const onboardConfig = { id: "bench", sourcePath: "refs/oracle/dense-hull.glb", preparedPath: ".mesh2threejs/oracle/prepared.json", source: "bench", author: "bench", license: "MIT", redistribution: "p", coordinateFrame: "rh", upAxis: "+y", forwardAxis: "+z", grounding: "min-y", scale: 1, semanticMap, articulationMap: {}, normalization: { translation: [0,0,0], rotationEuler: [0,0,0], scale: 1 }, authoritativeDimensions: null, dimensionSources: [] };
await writeFile(join(root, "onboard.json"), JSON.stringify(onboardConfig));
await runCli(["onboard", root, "--config", join(root, "onboard.json")], { stdout(){}, stderr(){} });
await writeFile(join(root, "reg.json"), JSON.stringify({ forwardAxis:"+z", upAxis:"+y", expectedScale:1, groundY:0.5, requiredSemantics:["hull"], requiredPivots:[], tolerance:0.02 }));
await runCli(["register", root, "--config", join(root, "reg.json")], { stdout(){}, stderr(){} });
await runCli(["oracle-sanity", root], { stdout(){}, stderr(){} });
await runCli(["lock", root], { stdout(){}, stderr(){} });
const deriveStart = performance.now();
const out: string[] = [];
await runCli(["derive", root], { stdout: v=>out.push(v), stderr(){} });
const deriveMs = performance.now() - deriveStart;
const totalMs = performance.now() - start;
const afterRss = process.memoryUsage().rss;
const result = JSON.parse(out.at(-1)!);
const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, ".mesh2threejs", "derived", "hull.json"), "utf8"));
const report = {
  workload: "derived-seed: dense hull (tessellated loft + fender) → meshoptimizer simplify → active-phase gates",
  inputTriangles: manifest.inputTriangles,
  outputTriangles: manifest.outputTriangles,
  deriveElapsedMs: Math.round(deriveMs),
  totalElapsedMs: Math.round(totalMs),
  peakRssBytes: afterRss,
  peakRssDeltaBytes: afterRss - beforeRss,
  tier: result.selected?.tier ?? result.tiers[0]?.tier,
  passed: result.status === "seed-passing",
  activePhaseScore: result.selected?.score ?? result.tiers[0]?.score,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.passed) throw new Error("derived-seed benchmark expected a passing tier");
if (report.deriveElapsedMs > 30_000) throw new Error(`derive exceeded 30s ceiling: ${report.deriveElapsedMs}ms`);

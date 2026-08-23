import type { Bounds3, CaptureCamera, GateReport, GateRow, SceneComponent, SceneSnapshot, SceneTriangle } from "../types.js";
import { rowsToWorkorders, scoreSilhouetteCurves, type CurvePoint } from "../core/compare.js";
import { checkWatertightness, countConnectedIslands, measureBounds, measureRobustBounds, measureSection, silhouetteCurves } from "../core/measurement.js";
import { deriveCanonicalFrame, rasterizeCapture, standardRenderProfile } from "../core/render.js";
import { filterSnapshot } from "./generic.js";
import { sceneTriangleAt } from "../core/geometry.js";
import type { PerformanceRecorder } from "../core/performance.js";

export const TANK_CANONICAL_FRAME = { x: "right", y: "up", z: "forward", ground: "minY", gunForward: "+Z" } as const;

function isHullId(id: string): boolean { return id.startsWith("hull"); }
function isHullComponent(c: SceneComponent): boolean { return isHullId(c.id); }

function componentsBy(snapshot: SceneSnapshot, predicate: (component: SceneComponent) => boolean): SceneComponent[] {
  return Object.values(snapshot.components).filter(predicate);
}

function boundsOf(snapshot: SceneSnapshot, predicate: (component: SceneComponent) => boolean): Bounds3 {
  return measureBounds(snapshot, predicate);
}

function comparisonRow(code: string, component: string, oracle: number, candidate: number, tolerance = 0.01): GateRow {
  const deviation = candidate - oracle;
  const normalizedDeviation = Math.abs(deviation) / Math.max(Math.abs(oracle), 1e-9);
  return {
    code,
    component,
    passed: normalizedDeviation <= tolerance,
    score: Math.max(0, 100 - normalizedDeviation * 1000),
    severity: "critical",
    message: `${component}: expected ${oracle.toFixed(4)}, measured ${candidate.toFixed(4)}`,
    oracleValue: oracle,
    candidateValue: candidate,
    deviation,
    normalizedDeviation,
  };
}

function centerOf(components: SceneComponent[]): [number, number, number] {
  if (!components.length) return [Infinity, Infinity, Infinity];
  const min = [0, 1, 2].map((axis) => Math.min(...components.map((component) => component.bounds.min[axis] ?? Infinity)));
  const max = [0, 1, 2].map((axis) => Math.max(...components.map((component) => component.bounds.max[axis] ?? -Infinity)));
  return [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
}

function sectionContourMetrics(snapshot: SceneSnapshot, z: number, hullIds: string[], boundsZSize: number): { upperW: number; lowerW: number; w: number; h: number; pts: number[] } | null {
  const sec = measureSection(snapshot, { axis: "z", position: z, thickness: boundsZSize / 140, semanticIds: hullIds });
  if (sec.sampleCount < 6) return null;
  const thickness = boundsZSize / 140;
  const pts: Array<[number, number]> = [];
  const cx = (sec.min[0] + sec.max[0]) / 2;
  const cy = (sec.min[1] + sec.max[1]) / 2;
  for (let i = 0; i < snapshot.triangleCount; i++) {
    const t = sceneTriangleAt(snapshot, i);
    if (!t || !hullIds.includes(t.componentId)) continue;
    for (const p of t.points) if (Math.abs(p[2] - z) <= thickness / 2 + 1e-9) pts.push([p[0], p[1]]);
  }
  if (pts.length < 8) return { upperW: sec.size[0], lowerW: sec.size[0], w: sec.size[0], h: sec.size[1], pts: [] };
  const midY = cy;
  const upper = pts.filter(([, y]) => y >= midY).map(([x]) => x);
  const lower = pts.filter(([, y]) => y < midY).map(([x]) => x);
  const range = (arr: number[]): number => arr.length ? Math.max(...arr) - Math.min(...arr) : sec.size[0];
  return { upperW: range(upper), lowerW: range(lower), w: sec.size[0], h: sec.size[1], pts: pts.flat() };
}

function hullSectionsRow(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow {
  const oracleHull = componentsBy(oracle, isHullComponent);
  const candidateHull = componentsBy(candidate, isHullComponent);
  const oracleBounds = boundsOf(oracle, isHullComponent);
  const candidateBounds = boundsOf(candidate, isHullComponent);
  if (!oracleHull.length || !candidateHull.length) {
    return { code: "hull.sections", phase: "hull", component: "hull", passed: false, score: 0, severity: "critical", message: "hull semantics are missing" };
  }
  const oracleIds = oracleHull.map((c) => c.id);
  const candidateIds = candidateHull.map((c) => c.id);
  const errors: number[] = [];
  const locations: NonNullable<GateRow["worstLocations"]> = [];
  for (let index = 0; index < 14; index += 1) {
    const fraction = (index + 0.5) / 14;
    const oracleZ = oracleBounds.min[2] + oracleBounds.size[2] * fraction;
    const candidateZ = candidateBounds.min[2] + candidateBounds.size[2] * fraction;
    const oM = sectionContourMetrics(oracle, oracleZ, oracleIds, oracleBounds.size[2]);
    const cM = sectionContourMetrics(candidate, candidateZ, candidateIds, candidateBounds.size[2]);
    if (!oM || !cM) { errors.push(1); continue; }
    const wErr = Math.abs(oM.w - cM.w) / Math.max(oM.w, 0.1);
    const hErr = Math.abs(oM.h - cM.h) / Math.max(oM.h, 0.1);
    const shapeErr = Math.abs((oM.upperW - oM.lowerW) / Math.max(oM.w, 1e-9) - (cM.upperW - cM.lowerW) / Math.max(cM.w, 1e-9));
    const upperErr = Math.abs(oM.upperW - cM.upperW) / Math.max(oM.upperW, 0.1);
    const err = Math.max(wErr, hErr, shapeErr * 2, upperErr);
    errors.push(err);
    locations.push({ position: oracleZ, oracleValue: oM.upperW, candidateValue: cM.upperW, physicalDeviation: cM.upperW - oM.upperW });
  }
  const sorted = [...errors].sort((a, b) => a - b).slice(0, 12);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / Math.max(sorted.length, 1);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 1;
  const score = Math.max(0, 100 - mean * 300 - p95 * 100);
  const hasShapeFail = errors.some((e) => e > 0.12);
  const finalScore = hasShapeFail ? Math.min(score, 74) : score;
  const worst = [...locations].sort((a, b) => Math.abs(b.physicalDeviation) - Math.abs(a.physicalDeviation))[0];
  const structural = mean > 0.08 ? " REBUILD REPRESENTATION: contour shape mismatch, do not micro-tune AABB" : "";
  return {
    code: "hull.sections",
    phase: "hull",
    category: "cross-section-contour",
    component: "hull",
    view: "section-z",
    ...(worst ? { position: worst.position } : {}),
    passed: finalScore >= 90,
    score: finalScore,
    severity: "critical",
    message: `hull section contour mean ${(mean * 100).toFixed(2)}%, P95 ${(p95 * 100).toFixed(2)}% after trimming 2 edge outliers${structural}`,
    ...(worst ? { oracleValue: worst.oracleValue, candidateValue: worst.candidateValue, deviation: worst.physicalDeviation } : {}),
    normalizedDeviation: mean,
    statistics: { mean, p95, coverage: locations.length / 14, sampleCount: 14, trimmedCount: 2 },
    worstLocations: [...locations].sort((a, b) => Math.abs(b.physicalDeviation) - Math.abs(a.physicalDeviation)).slice(0, 6),
    physicalUnit: "object-unit",
  };
}

function hullStationRowLegacy(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow {
  const oracleHull = componentsBy(oracle, isHullComponent);
  const candidateHull = componentsBy(candidate, isHullComponent);
  const oracleBounds = boundsOf(oracle, isHullComponent);
  const candidateBounds = boundsOf(candidate, isHullComponent);
  if (!oracleHull.length || !candidateHull.length) return { code: "hull.stations", phase: "hull", component: "hull", passed: false, score: 0, severity: "critical", message: "hull semantics are missing" };
  const oracleIds = oracleHull.map((c) => c.id);
  const candidateIds = candidateHull.map((c) => c.id);
  const errors: number[] = [];
  const locations: NonNullable<GateRow["worstLocations"]> = [];
  for (let index = 0; index < 14; index += 1) {
    const fraction = (index + 0.5) / 14;
    const oracleZ = oracleBounds.min[2] + oracleBounds.size[2] * fraction;
    const candidateZ = candidateBounds.min[2] + candidateBounds.size[2] * fraction;
    const a = measureSection(oracle, { axis: "z", position: oracleZ, thickness: oracleBounds.size[2] / 140, semanticIds: oracleIds });
    const b = measureSection(candidate, { axis: "z", position: candidateZ, thickness: candidateBounds.size[2] / 140, semanticIds: candidateIds });
    const error = Math.max(Math.abs(a.size[0] - b.size[0]) / Math.max(a.size[0], 0.1), Math.abs(a.size[1] - b.size[1]) / Math.max(a.size[1], 0.1));
    errors.push(error);
    locations.push({ position: oracleZ, oracleValue: a.size[0], candidateValue: b.size[0], physicalDeviation: b.size[0] - a.size[0] });
  }
  const sorted = [...errors].sort((a, b) => a - b).slice(0, 12);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / Math.max(sorted.length, 1);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 1;
  const score = Math.max(0, 100 - mean * 1000);
  const worst = [...locations].sort((a, b) => Math.abs(b.physicalDeviation) - Math.abs(a.physicalDeviation))[0];
  return { code: "hull.stations", phase: "hull", component: "hull", passed: score >= 90, score, severity: "critical", message: `legacy hull station mean ${(mean * 100).toFixed(2)}%, P95 ${(p95 * 100).toFixed(2)}%`, ...(worst ? { position: worst.position, oracleValue: worst.oracleValue, candidateValue: worst.candidateValue, deviation: worst.physicalDeviation } : {}), normalizedDeviation: mean, statistics: { mean, p95, coverage: locations.length / 14, sampleCount: 14, trimmedCount: 2 }, worstLocations: [...locations].sort((a, b) => Math.abs(b.physicalDeviation) - Math.abs(a.physicalDeviation)).slice(0, 6), physicalUnit: "object-unit" };
}

function hullPlanesRow(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow {
  const collect = (snap: SceneSnapshot): Map<string, number> => {
    const buckets = new Map<string, number>();
    for (let i = 0; i < snap.triangleCount; i++) {
      const t = sceneTriangleAt(snap, i);
      if (!t || !isHullId(t.componentId)) continue;
      const n = t.normal;
      const key = `${Math.round(n[0] * 2) / 2},${Math.round(n[1] * 2) / 2},${Math.round(n[2] * 2) / 2}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return buckets;
  };
  const oB = collect(oracle);
  const cB = collect(candidate);
  const totalO = [...oB.values()].reduce((s, v) => s + v, 0) || 1;
  const totalC = [...cB.values()].reduce((s, v) => s + v, 0) || 1;
  let maxDev = 0;
  const missing: string[] = [];
  for (const [k, count] of oB) {
    if (count / totalO < 0.04) continue;
    const ratioO = count / totalO;
    const ratioC = (cB.get(k) ?? 0) / totalC;
    const dev = Math.abs(ratioO - ratioC) / Math.max(ratioO, 0.05);
    maxDev = Math.max(maxDev, dev);
    if (ratioC < ratioO * 0.5) missing.push(k);
  }
  const slopedOracle = [...oB.keys()].some((k) => { const [x, y] = k.split(",").map(Number); return Math.abs(y ?? 0) > 0.3 && Math.abs(x ?? 0) > 0.3; });
  const slopedCandidate = [...cB.keys()].some((k) => { const [x, y] = k.split(",").map(Number); return Math.abs(y ?? 0) > 0.3 && Math.abs(x ?? 0) > 0.3; });
  const slopePenalty = slopedOracle && !slopedCandidate ? 0.6 : 0;
  const err = Math.max(maxDev, slopePenalty);
  const score = Math.max(0, 100 - err * 120);
  const passed = score >= 85 && missing.length === 0 && !(slopedOracle && !slopedCandidate);
  return { code: "hull.planes", phase: "hull", category: "principal-planes", component: "hull", passed, score: passed ? Math.max(score, 85) : Math.min(score, 70), severity: "critical", message: missing.length ? `missing sloped plane buckets: ${missing.slice(0, 3).join(";")}` : slopedOracle && !slopedCandidate ? "candidate lacks sloped armor planes" : `hull plane deviation ${(err * 100).toFixed(1)}%`, normalizedDeviation: err, physicalUnit: "ratio" };
}

function hullContiguityRow(candidate: SceneSnapshot): GateRow {
  const hullIds = Object.keys(candidate.components).filter(isHullId);
  if (hullIds.length <= 1) {
    const single = hullIds[0] ? candidate.components[hullIds[0]] : undefined;
    if (!single) return { code: "hull.contiguity", phase: "hull", component: "hull", passed: false, score: 0, severity: "critical", message: "hull missing" };
    const islands = countConnectedIslands(candidate, single.id);
    return { code: "hull.contiguity", phase: "hull", component: "hull", passed: islands === 1, score: islands === 1 ? 100 : 0, severity: "critical", message: islands === 1 ? "hull is contiguous" : `hull has ${islands} disconnected islands` };
  }
  let disconnected = 0;
  const gaps: number[] = [];
  for (let i = 0; i < hullIds.length; i++) for (let j = i + 1; j < hullIds.length; j++) {
    const a = candidate.components[hullIds[i]!]!, b = candidate.components[hullIds[j]!]!;
    const gap = Math.sqrt([0, 1, 2].reduce((s, axis) => { const g = Math.max(0, (a.bounds.min[axis] ?? 0) - (b.bounds.max[axis] ?? 0), (b.bounds.min[axis] ?? 0) - (a.bounds.max[axis] ?? 0)); return s + g * g; }, 0));
    gaps.push(gap);
    if (gap > Math.max(...candidate.components[hullIds[i]!]!.bounds.size) * 0.02) disconnected += 1;
  }
  const touchingPairs = gaps.filter((g) => g <= 0.01).length;
  const needed = hullIds.length - 1;
  const isSlabStack = hullIds.length >= 6 && touchingPairs < needed;
  const score = isSlabStack ? 0 : disconnected ? Math.max(0, 100 - disconnected * 30) : 100;
  return { code: "hull.contiguity", phase: "hull", component: "hull", passed: !isSlabStack && score >= 90, score, severity: "critical", message: isSlabStack ? `stack of ${hullIds.length} isolated hull slabs detected` : disconnected ? `hull has ${disconnected} gaps` : "hull contiguity passed", normalizedDeviation: disconnected / Math.max(hullIds.length, 1) };
}

function turretSectionsRow(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow {
  const oracleTurret = componentsBy(oracle, (c) => c.id === "turret" || c.id === "cupola");
  const candidateTurret = componentsBy(candidate, (c) => c.id === "turret" || c.id === "cupola");
  if (!oracleTurret.length || !candidateTurret.length) return { code: "turret.sections", phase: "turret", component: "turret", passed: false, score: 0, severity: "critical", message: "turret semantics missing" };
  const oBounds = boundsOf(oracle, (c) => c.id === "turret");
  const cBounds = boundsOf(candidate, (c) => c.id === "turret");
  const levels = [0.25, 0.5, 0.75];
  const errors: number[] = [];
  for (const f of levels) {
    const oy = oBounds.min[1] + oBounds.size[1] * f;
    const cy = cBounds.min[1] + cBounds.size[1] * f;
    const oSec = measureSection(oracle, { axis: "y", position: oy, thickness: oBounds.size[1] / 40, semanticIds: ["turret", "cupola"] });
    const cSec = measureSection(candidate, { axis: "y", position: cy, thickness: cBounds.size[1] / 40, semanticIds: ["turret", "cupola"] });
    const err = Math.max(Math.abs(oSec.size[0] - cSec.size[0]) / Math.max(oSec.size[0], 0.1), Math.abs(oSec.size[2] - cSec.size[2]) / Math.max(oSec.size[2], 0.1));
    const shapeErr = (() => {
      const oPts: Array<[number, number]> = []; const cPts: Array<[number, number]> = [];
      for (let i = 0; i < oracle.triangleCount; i++) { const t = sceneTriangleAt(oracle, i); if (t && (t.componentId === "turret" || t.componentId === "cupola") && Math.abs(t.points[0][1] - oy) < oBounds.size[1] / 30) oPts.push([t.points[0][0], t.points[0][2]] as any); }
      if (oPts.length < 6) return 0;
      const extent = (pts: Array<[number, number]>): number => Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
      return 0;
    })();
    errors.push(err);
  }
  const mean = errors.reduce((s, v) => s + v, 0) / errors.length;
  const score = Math.max(0, 100 - mean * 500);
  const isBox = (() => {
    const c = candidate.components.turret;
    if (!c) return false;
    const sx = c.bounds.size[0], sz = c.bounds.size[2];
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < candidate.triangleCount; i++) { const t = sceneTriangleAt(candidate, i); if (t && t.componentId === "turret") pts.push([t.points[0][0], t.points[0][2]]); }
    return false;
  })();
  void isBox;
  const boxPenalty = (() => {
    const c = candidate.components.turret;
    if (!c || !oracle.components.turret) return 0;
    const cr = Math.max(c.bounds.size[0], c.bounds.size[2]) / Math.min(c.bounds.size[0], c.bounds.size[2]);
    const or = Math.max(oracle.components.turret.bounds.size[0], oracle.components.turret.bounds.size[2]) / Math.min(oracle.components.turret.bounds.size[0], oracle.components.turret.bounds.size[2]);
    if (c.representation.segmentCounts.length === 0 && Math.abs(cr - 1) < 0.05 && Math.abs(or - 1) > 0.15) return 0.4;
    const hasBox = c.representation.segmentCounts.length === 0 && candidate.components.turret?.triangleIndices.length === 12;
    return hasBox ? 0.3 : 0;
  })();
  const finalErr = mean + boxPenalty;
  const finalScore = Math.max(0, 100 - finalErr * 400);
  return { code: "turret.sections", phase: "turret", component: "turret", passed: finalScore >= 90, score: finalScore, severity: "critical", message: `turret contour mean ${(finalErr * 100).toFixed(1)}%`, normalizedDeviation: finalErr, physicalUnit: "object-unit" };
}

function turretContiguityRow(candidate: SceneSnapshot): GateRow {
  const ids = ["turret", "cupola"].filter((id) => candidate.components[id]);
  if (!ids.length) return { code: "turret.contiguity", phase: "turret", component: "turret", passed: false, score: 0, severity: "critical", message: "turret missing" };
  const islands = ids.map((id) => countConnectedIslands(candidate, id));
  const passed = islands.every((n) => n === 1);
  return { code: "turret.contiguity", phase: "turret", component: "turret", passed, score: passed ? 100 : 0, severity: "critical", message: passed ? "turret contiguous" : `turret islands ${islands.join(",")}` };
}

function runningGearRadialityAndAxleRows(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow[] {
  const gearRole = (c: SceneComponent): string | undefined => c.role ?? ["road-wheel", "sprocket", "idler", "return-roller"].find((r) => c.id.startsWith(`${r}-`) || c.id === r);
  const oracleGear = componentsBy(oracle, (c) => Boolean(gearRole(c)));
  const candidateGear = componentsBy(candidate, (c) => Boolean(gearRole(c)));
  if (!oracleGear.length) return [];
  const radialRows: GateRow[] = [];
  let maxAxleDev = 0;
  for (const exp of oracleGear) {
    const act = candidate.components[exp.id] ?? candidateGear.find((c) => gearRole(c) === gearRole(exp) && Math.abs(c.bounds.center[2] - exp.bounds.center[2]) < 0.3);
    if (!act) continue;
    const center: [number, number, number] = [...act.bounds.center] as any;
    const dists: number[] = [];
    for (const idx of act.triangleIndices) {
      const t = sceneTriangleAt(candidate, idx);
      if (!t) continue;
      for (const p of t.points) dists.push(Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]));
    }
    if (dists.length < 12) continue;
    const mean = dists.reduce((s, v) => s + v, 0) / dists.length;
    const variance = dists.reduce((s, v) => s + Math.abs(v - mean), 0) / dists.length / Math.max(mean, 1e-9);
    const radialScore = Math.max(0, 100 - variance * 600);
    const isBox = act.representation.segmentCounts.length === 0 && variance > 0.15;
    if (isBox) radialRows.push({ code: `running-gear.radiality.${act.id}`, phase: "running-gear", component: act.id, passed: false, score: Math.min(radialScore, 55), severity: "critical", message: `${act.id} is box, not radial (variance ${(variance * 100).toFixed(1)}%)`, normalizedDeviation: variance } as any);

    const axleY = Math.abs(act.bounds.size[0]);
    const axleZ = Math.abs(act.bounds.size[1]);
    const isLateral = (act.bounds.size[0] < act.bounds.size[1] * 0.5 || act.bounds.size[0] < act.bounds.size[2] * 0.5);
    const axleErr = isLateral ? 0 : 0.3;
    maxAxleDev = Math.max(maxAxleDev, axleErr);
  }
  const boxDetected = candidateGear.some((c) => c.representation.segmentCounts.length === 0 && c.triangleIndices.length === 12);
  const overallRadialPassed = radialRows.length === 0 && !boxDetected;
  const radialSummary: GateRow = { code: "running-gear.radiality", phase: "running-gear", component: "road-wheels", passed: overallRadialPassed, score: overallRadialPassed ? 100 : 45, severity: "critical", message: overallRadialPassed ? "wheels are radial" : `box wheels detected: ${[...radialRows.map((r) => r.component), ...(boxDetected ? ["box-geometry-wheel"] : [])].join(",")}` };
  const axleRow: GateRow = { code: "running-gear.axles", phase: "running-gear", component: "road-wheels", passed: maxAxleDev < 0.1, score: Math.max(0, 100 - maxAxleDev * 300), severity: "critical", message: maxAxleDev < 0.1 ? "axles lateral" : "axle direction wrong" };
  return [radialSummary, axleRow, ...radialRows];
}

function curve(snapshot: SceneSnapshot, camera: CaptureCamera, resolution: number, orthographicHeight: number): CurvePoint[] {
  const profile = standardRenderProfile({ width: resolution, height: resolution });
  profile.camera.orthographicHeight = orthographicHeight;
  profile.camera.far = Math.max(profile.camera.far, orthographicHeight * 4);
  const frame = rasterizeCapture(snapshot, profile, camera, "alpha-silhouette");
  return silhouetteCurves(frame).columns.map((column, index) => column ? [index, -column.top, -column.bottom] : null);
}

function curveRows(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow[] {
  const oracleBounds = measureBounds(oracle);
  const minimumFeature = Math.max(Math.min(...oracleBounds.size.filter((value) => value > 0)) / 120, Math.max(...oracleBounds.size) / 1000);
  const frame = deriveCanonicalFrame(oracleBounds, minimumFeature);
  const views: Array<{ id: "side" | "plan" | "front"; camera: CaptureCamera }> = ["side", "plan", "front"].map((id) => ({ id: id as "side" | "plan" | "front", camera: frame.cameras[id as "side" | "plan" | "front"] }));
  const oracleHull = filterSnapshot(oracle, (component) => isHullComponent(component));
  const candidateHull = filterSnapshot(candidate, (component) => isHullComponent(component));
  const oracleTurret = filterSnapshot(oracle, (component) => ["turret", "cupola"].includes(component.id));
  const candidateTurret = filterSnapshot(candidate, (component) => ["turret", "cupola"].includes(component.id));
  const hullScores = new Map<string, ReturnType<typeof scoreSilhouetteCurves>>();
  const wholeScores = new Map<string, ReturnType<typeof scoreSilhouetteCurves>>();
  const turretScores = new Map<string, ReturnType<typeof scoreSilhouetteCurves>>();
  for (const view of views) {
    const hull = scoreSilhouetteCurves(curve(oracleHull, view.camera, frame.width, frame.orthographicHeight), curve(candidateHull, view.camera, frame.width, frame.orthographicHeight), frame.width);
    hullScores.set(view.id, hull);
    wholeScores.set(view.id, scoreSilhouetteCurves(curve(oracle, view.camera, frame.width, frame.orthographicHeight), curve(candidate, view.camera, frame.width, frame.orthographicHeight), frame.width, hull.registration));
    if (view.id !== "front") {
      turretScores.set(view.id, scoreSilhouetteCurves(curve(oracleTurret, view.camera, frame.width, frame.orthographicHeight), curve(candidateTurret, view.camera, frame.width, frame.orthographicHeight), frame.width, hull.registration));
    }
  }
  const category = (code: string, component: string, scores: Map<string, ReturnType<typeof scoreSilhouetteCurves>>): GateRow => {
    const entries = [...scores.entries()];
    const worst = entries.sort(([, a], [, b]) => a.score - b.score)[0];
    const score = worst?.[1].score ?? 0;
    const column = worst?.[1].worst[0];
    const horizontalObjectUnit = (value: number): number => value / frame.horizontalPixelsPerUnit;
    const verticalObjectUnit = (value: number): number => value / frame.verticalPixelsPerUnit;
    return {
      code,
      phase: component === "hull" ? "hull" : component === "turret" ? "turret" : "final",
      category: "silhouette-curve",
      component,
      ...(worst?.[0] ? { view: worst[0] } : {}),
      viewsEvaluated: entries.map(([view]) => view).sort(),
      ...(column ? { position: horizontalObjectUnit(column.position - (frame.width - 1) / 2), oracleValue: verticalObjectUnit(column.oracleTop), candidateValue: verticalObjectUnit(column.candidateTop), deviation: verticalObjectUnit(column.candidateTop - column.oracleTop) } : {}),
      passed: score >= 90,
      score,
      severity: "critical",
      message: `${component} curve floor ${score.toFixed(1)} in ${worst?.[0] ?? "unavailable"}; required 90${score < 80 ? " — REBUILD REPRESENTATION" : ""}`,
      normalizedDeviation: (100 - score) / 100,
      ...(worst?.[1].registration ? { registration: { dAlong: horizontalObjectUnit(worst[1].registration.dAlong), vertical: verticalObjectUnit(worst[1].registration.vertical), kind: "translation-only" as const } } : {}),
      ...(worst ? { statistics: { mean: worst[1].meanPct / 100, p95: worst[1].p95Pct / 100, coverage: 1 - worst[1].coverPct / 100, sampleCount: worst[1].worst.length } } : {}),
      ...(worst ? { worstLocations: worst[1].worst.slice(0, 6).map((item) => ({ position: horizontalObjectUnit(item.position - (frame.width - 1) / 2), oracleValue: verticalObjectUnit(item.oracleTop), candidateValue: verticalObjectUnit(item.candidateTop), physicalDeviation: verticalObjectUnit(item.candidateTop - item.oracleTop) })) } : {}),
      physicalUnit: "object-unit",
    };
  };
  return [category("curves.hull", "hull", hullScores), category("curves.whole", "whole-vehicle", wholeScores), category("curves.turret", "turret", turretScores)];
}

function fabricationRow(candidate: SceneSnapshot): GateRow {
  const structural = Object.values(candidate.components)
    .filter((component) => isHullId(component.id) || ["turret"].includes(component.id))
    .map((component) => component.id);
  const checks = checkWatertightness(candidate, structural);
  const boundaryEdges = checks.reduce((sum, check) => sum + check.boundaryEdges, 0);
  const disconnected = structural.filter((id) => countConnectedIslands(candidate, id) > 1);
  return {
    code: "fabrication.profile",
    component: "major-masses",
    phase: "style-fabrication",
    passed: checks.length === structural.length && boundaryEdges === 0 && disconnected.length === 0,
    score: checks.length === structural.length && boundaryEdges === 0 && disconnected.length === 0 ? 100 : 0,
    severity: "critical",
    message: `major-mass open boundary edges: ${boundaryEdges}; disconnected major masses: ${disconnected.join(", ") || "none"}`,
    oracleValue: 0,
    candidateValue: boundaryEdges,
    deviation: boundaryEdges,
  };
}

function boundsGap(a: Bounds3, b: Bounds3): number {
  return Math.sqrt([0, 1, 2].reduce((sum, axis) => {
    const gap = Math.max(0, (a.min[axis] ?? 0) - (b.max[axis] ?? 0), (b.min[axis] ?? 0) - (a.max[axis] ?? 0));
    return sum + gap * gap;
  }, 0));
}

function pointBoundsGap(point: readonly number[], bounds: Bounds3): number {
  return Math.sqrt([0, 1, 2].reduce((sum, axis) => {
    const value = point[axis] ?? 0;
    const gap = Math.max(0, (bounds.min[axis] ?? 0) - value, value - (bounds.max[axis] ?? 0));
    return sum + gap * gap;
  }, 0));
}

function ownedSeatingGap(snapshot: SceneSnapshot, component: SceneComponent, turret: SceneComponent): number {
  if (component.id === "turret") return 0;
  let gap = boundsGap(component.bounds, turret.bounds);
  if (component.triangleIndices.length === 0 && component.origin) {
    gap = Math.min(gap, pointBoundsGap(component.origin, turret.bounds));
  }
  const parent = component.parentSemanticId ? snapshot.components[component.parentSemanticId] : undefined;
  if (parent?.origin) gap = Math.min(gap, pointBoundsGap(parent.origin, component.bounds));
  return gap;
}

function floaterRow(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow {
  const oracleTurret = oracle.components.turret;
  const turret = candidate.components.turret;
  const seatingTolerance = Math.max(...measureBounds(candidate, isHullComponent).size) * 0.05;
  const expectedOwned = Object.values(oracle.components).filter((component) =>
    component.parentSemanticId === "turret-pivot" || component.parentSemanticId === "gun-pivot");
  const failures = expectedOwned.filter((component) => {
    const actual = candidate.components[component.id];
    if (!actual || !turret || !oracleTurret) return true;
    const allowedGap = ownedSeatingGap(oracle, component, oracleTurret) + seatingTolerance;
    return actual.parentSemanticId !== component.parentSemanticId || ownedSeatingGap(candidate, actual, turret) > allowedGap;
  });
  return {
    code: "ownership.seating",
    phase: "fittings-articulation",
    component: "turret-owned-components",
    passed: failures.length === 0,
    score: failures.length ? 0 : 100,
    severity: "critical",
    message: failures.length ? `detached or missing turret-owned components: ${failures.map((item) => item.id).join(", ")}` : "turret-owned components remain physically seated",
    oracleValue: 0,
    candidateValue: failures.length,
  };
}

export function evaluateTankPoseRows(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow[] {
  return [floaterRow(oracle, candidate)];
}

export function evaluateTankProfile(oracle: SceneSnapshot, candidate: SceneSnapshot, options: TankOptions): GateReport {
  if (options.certification === "exact-real" && !options.authoritativeDimensions) {
    throw new Error("exact-real certification requires authoritative dimensions");
  }
  const dimensionKeys = ["hullLength", "overallLength", "width", "height"] as const;
  if (options.authoritativeDimensions && !dimensionKeys.every((key) => Number.isFinite(options.authoritativeDimensions?.[key]) && options.authoritativeDimensions![key] > 0)) throw new Error(`authoritative tank dimensions require ${dimensionKeys.join(", ")}`);
  if (options.authoritativeDimensions && Object.values(options.authoritativeDimensions).some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("authoritative tank dimensions must be positive finite values");
  const oracleHullBounds = measureBounds(oracle, isHullComponent);
  const measuredHullBounds = measureBounds(candidate, isHullComponent);
  const requiredHullLength = options.authoritativeDimensions?.hullLength ?? oracleHullBounds.size[2];

  const hullSections = options.performance?.measure("fourteen-hull-stations", () => hullSectionsRow(oracle, candidate)) ?? hullSectionsRow(oracle, candidate);
  const hullPlanes = options.performance?.measure("hull-planes", () => hullPlanesRow(oracle, candidate)) ?? hullPlanesRow(oracle, candidate);
  const hullContiguity = hullContiguityRow(candidate);
  const legacyStations = hullStationRowLegacy(oracle, candidate);

  const rows: GateRow[] = [
    ...(options.performance?.measure("whole-hull-turret-silhouette", () => curveRows(oracle, candidate)) ?? curveRows(oracle, candidate)),
    hullSections,
    legacyStations,
    hullPlanes,
    hullContiguity,
    { ...comparisonRow("dimensions.hull-length", "hull", requiredHullLength, measuredHullBounds.size[2], 0.01), phase: "hull", physicalUnit: "object-unit" },
  ];
  const oracleTurret = componentsBy(oracle, (component) => component.id === "turret" || component.id === "turret-pivot");
  const candidateTurret = componentsBy(candidate, (component) => component.id === "turret" || component.id === "turret-pivot");
  const turretOracleCenter = oracle.components["turret-pivot"]?.origin ?? centerOf(oracleTurret);
  const turretCandidateCenter = candidate.components["turret-pivot"]?.origin ?? centerOf(candidateTurret);
  const turretPlacement = [0, 1, 2].map((axis) => comparisonRow(`turret.placement.${["lateral", "vertical", "longitudinal"][axis]}`, "turret", turretOracleCenter[axis]!, turretCandidateCenter[axis]!, 0.01));
  const worstTurret = turretPlacement.sort((a, b) => (b.normalizedDeviation ?? 0) - (a.normalizedDeviation ?? 0))[0]!;
  rows.push({ ...worstTurret, code: "turret.placement", phase: "turret", category: "ring-seat-3d", message: `turret ring placement: ${turretPlacement.map((row) => `${row.code.split(".").at(-1)}=${Math.abs(row.deviation ?? 0).toFixed(4)}`).join(", ")}` });
  rows.push(...(options.performance?.measure("turret-sections", () => [turretSectionsRow(oracle, candidate), turretContiguityRow(candidate)]) ?? [turretSectionsRow(oracle, candidate), turretContiguityRow(candidate)]));

  const oracleGun = boundsOf(oracle, (component) => component.id === "gun");
  const gunMetrics = (snapshot: SceneSnapshot) => {
    const pivot = snapshot.components["gun-pivot"]?.origin;
    const gun = snapshot.components.gun;
    if (!pivot || !gun) return null;
    const points = Array.from(gun.triangleIndices).flatMap((index) => sceneTriangleAt(snapshot, index)?.points ?? []);
    const muzzle = points.sort((a, b) => Math.hypot(b[0] - pivot[0], b[1] - pivot[1], b[2] - pivot[2]) - Math.hypot(a[0] - pivot[0], a[1] - pivot[1], a[2] - pivot[2]))[0];
    if (!muzzle) return null;
    const vector = muzzle.map((value, axis) => value - pivot[axis]!) as [number, number, number];
    const length = Math.hypot(...vector);
    return { pivot, muzzle, vector: vector.map((value) => value / Math.max(length, 1e-9)) as [number, number, number], length };
  };
  const expectedGun = gunMetrics(oracle); const actualGun = gunMetrics(candidate);
  const originError = expectedGun && actualGun ? Math.hypot(...expectedGun.pivot.map((value, axis) => value - actualGun.pivot[axis]!)) : Number.POSITIVE_INFINITY;
  const axisCosine = expectedGun && actualGun ? expectedGun.vector.reduce((sum, value, axis) => sum + value * actualGun.vector[axis]!, 0) : -1;
  const axisError = 1 - axisCosine;
  const lengthError = expectedGun && actualGun ? Math.abs(actualGun.length - expectedGun.length) / Math.max(expectedGun.length, 1e-9) : Number.POSITIVE_INFINITY;
  const gunError = Math.max(originError / Math.max(oracleGun.size[2], 1), axisError, lengthError);
  rows.push({ code: "gun.geometry", phase: "gun", category: "origin-axis-length-muzzle", component: "gun", passed: gunError <= 0.01, score: Number.isFinite(gunError) ? Math.max(0, 100 - gunError * 1000) : 0, severity: "critical", message: `gun origin error ${originError.toFixed(4)}, axis cosine ${axisCosine.toFixed(5)}, length error ${(lengthError * 100).toFixed(2)}%`, ...(expectedGun && actualGun ? { oracleValue: expectedGun.length, candidateValue: actualGun.length, deviation: actualGun.length - expectedGun.length } : {}), normalizedDeviation: gunError, physicalUnit: "object-unit" });
  const oracleGunPivot = oracle.components["gun-pivot"];
  const candidateGunPivot = candidate.components["gun-pivot"];
  const poseAvailable = Boolean(oracleGunPivot && candidateGunPivot && oracle.components.gun?.parentSemanticId === "gun-pivot" && candidate.components.gun?.parentSemanticId === "gun-pivot");
  rows.push({ code: "gun.pose", phase: "gun", component: "gun-pivot", passed: poseAvailable, score: poseAvailable ? 100 : 0, severity: "critical", message: poseAvailable ? "gun is owned by a physical pivot; pose sampling remains required as articulation evidence" : "gun requires a physical gun-pivot ownership chain" });

  const runningGearStarted = options.performance?.start();
  const oracleWheels = componentsBy(oracle, (component) => component.role === "road-wheel" || component.id.startsWith("road-wheel-"));
  const candidateWheels = componentsBy(candidate, (component) => component.role === "road-wheel" || component.id.startsWith("road-wheel-"));
  const gearRole = (component: SceneComponent): string | undefined => component.role ?? ["road-wheel", "sprocket", "idler", "return-roller"].find((role) => component.id.startsWith(`${role}-`) || component.id === role);
  const oracleGear = componentsBy(oracle, (component) => Boolean(gearRole(component)));
  const candidateGear = componentsBy(candidate, (component) => Boolean(gearRole(component)));
  const wheelCountPassed = oracleWheels.length === candidateWheels.length && oracleWheels.length > 0;
  rows.push({
    code: "running-gear.count",
    component: "road-wheels",
    phase: "running-gear",
    passed: wheelCountPassed,
    score: wheelCountPassed ? 100 : 0,
    severity: "critical",
    message: `expected ${oracleWheels.length} road wheels, measured ${candidateWheels.length}`,
    oracleValue: oracleWheels.length,
    candidateValue: candidateWheels.length,
    deviation: candidateWheels.length - oracleWheels.length,
  });
  const oracleOrdered = [...oracleGear].sort((a, b) => String(gearRole(a)).localeCompare(String(gearRole(b))) || a.bounds.center[0] - b.bounds.center[0] || a.bounds.center[2] - b.bounds.center[2]);
  const candidateById = new Map(candidateGear.map((wheel) => [wheel.id, wheel]));
  const instanceRows = oracleOrdered.map((expected, index): GateRow => {
    const sameRole = candidateGear.filter((item) => gearRole(item) === gearRole(expected)).sort((a, b) => a.bounds.center[0] - b.bounds.center[0] || a.bounds.center[2] - b.bounds.center[2]);
    const roleIndex = oracleOrdered.filter((item) => gearRole(item) === gearRole(expected)).indexOf(expected);
    const actual = candidateById.get(expected.id) ?? sameRole[roleIndex >= 0 ? roleIndex : index];
    if (!actual) return { code: `running-gear.instance.${expected.id}`, phase: "running-gear", component: expected.id, passed: false, score: 0, severity: "critical", message: `missing ordered running-gear instance ${expected.id}` };
    const centerError = Math.hypot(...expected.bounds.center.map((value, axis) => value - actual.bounds.center[axis]!));
    const radiusExpected = Math.max(expected.bounds.size[1], expected.bounds.size[2]) / 2;
    const radiusActual = Math.max(actual.bounds.size[1], actual.bounds.size[2]) / 2;
    const widthExpected = Math.min(...expected.bounds.size.filter((value) => value > 1e-9));
    const widthActual = Math.min(...actual.bounds.size.filter((value) => value > 1e-9));
    const relative = Math.max(centerError / Math.max(radiusExpected, 1e-9), Math.abs(radiusActual - radiusExpected) / Math.max(radiusExpected, 1e-9), Math.abs(widthActual - widthExpected) / Math.max(widthExpected, 1e-9));
    return { code: `running-gear.instance.${expected.id}`, phase: "running-gear", category: "ordered-instance", component: expected.id, passed: relative <= 0.01, score: Math.max(0, 100 - relative * 1000), severity: "critical", message: `${expected.id}: center error ${centerError.toFixed(4)}, radius ${radiusActual.toFixed(4)}/${radiusExpected.toFixed(4)}, width ${widthActual.toFixed(4)}/${widthExpected.toFixed(4)}`, oracleValue: radiusExpected, candidateValue: radiusActual, deviation: radiusActual - radiusExpected, normalizedDeviation: relative, physicalUnit: "object-unit" };
  });
  rows.push(...instanceRows);
  rows.push({ code: "running-gear.instances", phase: "running-gear", component: "running-gear", passed: wheelCountPassed && instanceRows.every((row) => row.passed), score: wheelCountPassed ? Math.min(...instanceRows.map((row) => row.score), 100) : 0, severity: "critical", message: wheelCountPassed && instanceRows.every((row) => row.passed) ? "all running-gear instances match by role, side, and order" : "one or more running-gear instances differs" });
  const centers = (items: SceneComponent[]): number[] => items.map((item) => item.bounds.center[2]).sort((a, b) => a - b);
  const spacingError = (a: number[], b: number[]): number => {
    if (a.length !== b.length || !a.length) return 1;
    return Math.max(...a.map((value, index) => Math.abs(value - (b[index] ?? value))));
  };
  const spacing = spacingError(centers(oracleWheels), centers(candidateWheels));
  rows.push({
    code: "running-gear.spacing",
    component: "road-wheels",
    phase: "running-gear",
    passed: spacing <= 0.02,
    score: Math.max(0, 100 - spacing * 100),
    severity: "critical",
    message: `road-wheel maximum center displacement ${spacing.toFixed(4)} m`,
    oracleValue: 0,
    candidateValue: spacing,
    deviation: spacing,
    normalizedDeviation: spacing / Math.max(measureBounds(oracle).size[2], 1),
  });
  rows.push(...runningGearRadialityAndAxleRows(oracle, candidate));
  if (runningGearStarted) options.performance!.recordSince("running-gear-matching", runningGearStarted);
  rows.push(options.performance?.measure("watertightness-connected-islands", () => fabricationRow(candidate)) ?? fabricationRow(candidate), floaterRow(oracle, candidate));

  const tracksStarted = options.performance?.start();
  const oracleTracks = componentsBy(oracle, (component) => component.role === "track-course" || component.id.startsWith("track-"));
  const candidateTracks = componentsBy(candidate, (component) => component.role === "track-course" || component.id.startsWith("track-"));
  const trackCountPassed = oracleTracks.length === candidateTracks.length && oracleTracks.length >= 2;
  const trackErrors = oracleTracks.map((expected) => {
    const actual = candidate.components[expected.id];
    if (!actual) return Number.POSITIVE_INFINITY;
    return Math.max(...[0, 1, 2].map((axis) => Math.abs(actual.bounds.center[axis]! - expected.bounds.center[axis]!) / Math.max(expected.bounds.size[axis]!, 0.1)), ...[0, 1, 2].map((axis) => Math.abs(actual.bounds.size[axis]! - expected.bounds.size[axis]!) / Math.max(expected.bounds.size[axis]!, 0.1)));
  });
  const hasCourseVoid = (snapshot: SceneSnapshot, component: SceneComponent): boolean => {
    const triangles = Array.from(component.triangleIndices, (index) => sceneTriangleAt(snapshot, index)).filter((value): value is SceneTriangle => Boolean(value));
    if (!triangles.length) return false;
    const filledCenterFaces = triangles.filter((triangle) => {
      const center = [0, 1, 2].map((axis) => triangle.points.reduce((sum, point) => sum + point[axis]!, 0) / 3);
      const nearSide = Math.abs(Math.abs(center[0]! - component.bounds.center[0]) - component.bounds.size[0] / 2) < component.bounds.size[0] * 0.15;
      const centralY = Math.abs(center[1]! - component.bounds.center[1]) < component.bounds.size[1] * 0.2;
      const centralZ = Math.abs(center[2]! - component.bounds.center[2]) < component.bounds.size[2] * 0.25;
      return nearSide && centralY && centralZ;
    });
    return filledCenterFaces.length === 0;
  };
  const courseTopologyPassed = candidateTracks.every((track) => hasCourseVoid(candidate, track));
  const courseContinuityPassed = candidateTracks.every((track) => countConnectedIslands(candidate, track.id) === 1);
  const oracleHullForTracks = measureBounds(oracle, isHullComponent);
  const candidateHullBounds = measureBounds(candidate, isHullComponent);
  const trackMetrics = (snapshot: SceneSnapshot, track: SceneComponent, gear: SceneComponent[], hull: Bounds3) => {
    const triangles = Array.from(track.triangleIndices, (index) => sceneTriangleAt(snapshot, index)!).filter(Boolean);
    const centers = triangles.map((triangle) => triangle.points.reduce((sum, point) => [sum[0] + point[0] / 3, sum[1] + point[1] / 3, sum[2] + point[2] / 3] as [number, number, number], [0, 0, 0] as [number, number, number]));
    const span = (values: number[]): number => values.length ? Math.max(...values) - Math.min(...values) : 0;
    const lower = centers.filter((point) => point[1] <= track.bounds.min[1] + track.bounds.size[1] * 0.18);
    const upper = centers.filter((point) => point[1] >= track.bounds.max[1] - track.bounds.size[1] * 0.18);
    const endIndices = centers.map((point, index) => Math.abs(point[2] - track.bounds.center[2]) >= track.bounds.size[2] * 0.38 ? index : -1).filter((index) => index >= 0);
    const diagonalWrapRatio = endIndices.length ? endIndices.filter((index) => Math.abs(triangles[index]!.normal[1]) > 0.15 && Math.abs(triangles[index]!.normal[2]) > 0.15).length / endIndices.length : 0;
    const wrapNormalBins = new Set(endIndices.map((index) => {
      const normal = triangles[index]!.normal;
      return Math.round(Math.atan2(Math.abs(normal[1]), Math.abs(normal[2])) / (Math.PI / 24));
    })).size;
    const penetration = centers.length ? centers.filter((point) => [0, 1, 2].every((axis) => point[axis]! >= hull.min[axis]! && point[axis]! <= hull.max[axis]!)).length / centers.length : 1;
    const sameSide = gear.filter((item) => Math.sign(item.bounds.center[0]) === Math.sign(track.bounds.center[0]));
    const gearZ = sameSide.map((item) => item.bounds.center[2]);
    const gearX = sameSide.length ? sameSide.reduce((sum, item) => sum + item.bounds.center[0], 0) / sameSide.length : Number.NaN;
    return {
      lowerRun: span(lower.map((point) => point[2])) / Math.max(track.bounds.size[2], 1e-9),
      upperRun: span(upper.map((point) => point[2])) / Math.max(track.bounds.size[2], 1e-9),
      diagonalWrapRatio,
      wrapNormalBins,
      penetration,
      frontClearance: gearZ.length ? track.bounds.max[2] - Math.max(...gearZ) : Number.NaN,
      rearClearance: gearZ.length ? Math.min(...gearZ) - track.bounds.min[2] : Number.NaN,
      lateralOffset: Number.isFinite(gearX) ? track.bounds.center[0] - gearX : Number.NaN,
    };
  };
  const courseDiagnosticFailures: string[] = [];
  let hullPenetration = 0;
  for (const expected of oracleTracks) {
    const actual = candidate.components[expected.id];
    if (!actual) { courseDiagnosticFailures.push(`${expected.id}:missing`); continue; }
    const expectedMetrics = trackMetrics(oracle, expected, oracleGear, oracleHullForTracks);
    const actualMetrics = trackMetrics(candidate, actual, candidateGear, candidateHullBounds);
    hullPenetration = Math.max(hullPenetration, actualMetrics.penetration);
    const clearanceScale = Math.max(expected.bounds.size[2], 1e-9);
    if (actualMetrics.lowerRun < expectedMetrics.lowerRun - 0.05) courseDiagnosticFailures.push(`${expected.id}:ground-run`);
    if (actualMetrics.upperRun < expectedMetrics.upperRun - 0.05) courseDiagnosticFailures.push(`${expected.id}:upper-run`);
    if (actualMetrics.diagonalWrapRatio + 0.01 < expectedMetrics.diagonalWrapRatio * 0.8) courseDiagnosticFailures.push(`${expected.id}:curved-wrap`);
    if (actualMetrics.wrapNormalBins < Math.max(3, Math.floor(expectedMetrics.wrapNormalBins * 0.8))) courseDiagnosticFailures.push(`${expected.id}:curved-wrap-normal-diversity`);
    if (actualMetrics.penetration > expectedMetrics.penetration + 0.05) courseDiagnosticFailures.push(`${expected.id}:3d-hull-envelope-penetration`);
    for (const key of ["frontClearance", "rearClearance", "lateralOffset"] as const) if (!Number.isFinite(actualMetrics[key]) || Math.abs(actualMetrics[key] - expectedMetrics[key]) / clearanceScale > 0.05) courseDiagnosticFailures.push(`${expected.id}:${key}`);
  }
  const trackEnvelopeError = Math.max(...trackErrors, 0);
  const trackPassed = trackCountPassed && trackEnvelopeError <= 0.01 && courseTopologyPassed && courseContinuityPassed && courseDiagnosticFailures.length === 0;
  rows.push({
    code: "track.course",
    component: "track-course",
    phase: "tracks",
    category: "course-envelope",
    passed: trackPassed,
    score: trackPassed ? 100 : Math.max(0, 100 - trackEnvelopeError * 1000),
    severity: "critical",
    message: `track count ${candidateTracks.length}/${oracleTracks.length}; envelope error ${trackEnvelopeError.toFixed(4)}; wrap void ${courseTopologyPassed ? "present" : "missing"}; continuous ${courseContinuityPassed}; 3D AABB hull-envelope penetration ${(hullPenetration * 100).toFixed(1)}%; course diagnostics ${courseDiagnosticFailures.join(", ") || "passed"}`,
    oracleValue: oracleTracks.length,
    candidateValue: candidateTracks.length,
    normalizedDeviation: trackEnvelopeError,
    physicalUnit: "object-unit",
  });
  if (tracksStarted) options.performance!.recordSince("track-diagnostics", tracksStarted);

  for (const feature of Object.values(oracle.components).filter((component) => component.critical)) {
    const present = Boolean(candidate.components[feature.id]);
    rows.push({
      code: `critical-feature.${feature.id}`,
      component: feature.id,
      passed: present,
      score: present ? 100 : 0,
      severity: "critical",
      message: present ? `${feature.id} retained` : `restore major identity feature ${feature.id}`,
      oracleValue: "present",
      candidateValue: present ? "present" : "missing",
    });
  }

  if (options.authoritativeDimensions) {
    const body = measureRobustBounds(candidate, { exclude: /(antenna|aerial|whip|gun)/iu });
    const overall = measureBounds(candidate, (component) => !/(antenna|aerial|whip)/iu.test(component.id));
    rows.push(
      comparisonRow("dimensions.width", "whole-vehicle", options.authoritativeDimensions.width, body.size[0], 0.01),
      comparisonRow("dimensions.height", "whole-vehicle", options.authoritativeDimensions.height, body.size[1], 0.01),
      comparisonRow("dimensions.overall-length", "whole-vehicle", options.authoritativeDimensions.overallLength, overall.size[2], 0.01),
    );
  }
  const frameValid = (): boolean => {
    const hullIds = Object.keys(candidate.components).filter(isHullId);
    if (!hullIds.length) return false;
    const wheels = componentsBy(candidate, (c) => c.role === "road-wheel" || c.id.startsWith("road-wheel-"));
    if (wheels.length >= 4) {
      const zs = wheels.map((w) => w.bounds.center[2]);
      const xs = wheels.map((w) => w.bounds.center[0]);
      const zVar = Math.max(...zs) - Math.min(...zs);
      const xVar = Math.max(...xs) - Math.min(...xs);
      if (zVar < xVar) return false;
    }
    return true;
  };
  const directionalSignature = (snapshot: SceneSnapshot): number => {
    const hull = snapshot.components.hull;
    const gun = snapshot.components.gun;
    const turret = snapshot.components.turret;
    if (!hull || !gun || !turret) return Number.NaN;
    return (gun.bounds.center[2] - turret.bounds.center[2]) + 0.25 * (turret.bounds.center[2] - hull.bounds.center[2]);
  };
  const oracleDirection = directionalSignature(oracle);
  const candidateDirection = directionalSignature(candidate);
  const frameOk = frameValid();
  const orientationPassed = frameOk && Number.isFinite(oracleDirection) && Number.isFinite(candidateDirection) && Math.sign(oracleDirection) === Math.sign(candidateDirection);
  rows.push({
    code: "orientation.physical",
    phase: "hull",
    category: "directional-landmarks",
    component: "whole-vehicle",
    passed: orientationPassed,
    score: orientationPassed ? 100 : 0,
    severity: "critical",
    message: !frameOk ? "canonical frame invalid; orientation unavailable" : `physical fore/aft landmark signature expected ${oracleDirection.toFixed(4)}, measured ${candidateDirection.toFixed(4)}; metadata is informational only`,
    oracleValue: oracleDirection,
    candidateValue: candidateDirection,
    deviation: candidateDirection - oracleDirection,
    physicalUnit: "object-unit",
  });

  const hullSil = rows.find((r) => r.code === "curves.hull");
  if (hullSil && hullSections.score > 95 && hullSil.score < 80) {
    rows.push({ code: "diagnosis.contradiction", phase: "hull", component: "hull", passed: false, score: 0, severity: "critical", message: "anti-gaming: high section envelope but poor silhouette — structural representation mismatch" });
  }

  return {
    profile: "tank",
    passed: rows.every((row) => row.passed),
    score: Math.min(...rows.map((row) => row.score)),
    rows,
    workorders: rowsToWorkorders(rows),
  };
}

interface TankOptions {
  certification: "exact-real" | "oracle-relative";
  authoritativeDimensions?: { hullLength: number; overallLength: number; width: number; height: number };
  performance?: PerformanceRecorder;
}

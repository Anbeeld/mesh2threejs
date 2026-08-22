import type { Bounds3, CaptureCamera, GateReport, GateRow, SceneComponent, SceneSnapshot } from "../types.js";
import { rowsToWorkorders, scoreSilhouetteCurves, type CurvePoint } from "../core/compare.js";
import { checkWatertightness, measureBounds, measureSection, silhouetteCurves } from "../core/measurement.js";
import { rasterizeCapture, standardRenderProfile } from "../core/render.js";
import { filterSnapshot } from "./generic.js";

interface TankOptions {
  certification: "exact-real" | "oracle-relative";
  authoritativeDimensions?: { hullLength: number; overallLength: number; width: number; height: number };
}

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

function hullStationRow(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow {
  const oracleHull = componentsBy(oracle, (component) => component.id.startsWith("hull"));
  const candidateHull = componentsBy(candidate, (component) => component.id.startsWith("hull"));
  const oracleBounds = boundsOf(oracle, (component) => component.id.startsWith("hull"));
  const candidateBounds = boundsOf(candidate, (component) => component.id.startsWith("hull"));
  if (!oracleHull.length || !candidateHull.length) {
    return { code: "hull.station", component: "hull", passed: false, score: 0, severity: "critical", message: "hull semantics are missing" };
  }
  const oracleIds = oracleHull.map((component) => component.id);
  const candidateIds = candidateHull.map((component) => component.id);
  const errors: number[] = [];
  let worstPosition = 0;
  let worstOracle = 0;
  let worstCandidate = 0;
  for (let index = 0; index < 14; index += 1) {
    const fraction = (index + 0.5) / 14;
    const oracleZ = oracleBounds.min[2] + oracleBounds.size[2] * fraction;
    const candidateZ = candidateBounds.min[2] + candidateBounds.size[2] * fraction;
    const a = measureSection(oracle, { axis: "z", position: oracleZ, thickness: oracleBounds.size[2] / 140, semanticIds: oracleIds });
    const b = measureSection(candidate, { axis: "z", position: candidateZ, thickness: candidateBounds.size[2] / 140, semanticIds: candidateIds });
    const error = Math.max(
      Math.abs(a.size[0] - b.size[0]) / Math.max(a.size[0], 0.1),
      Math.abs(a.size[1] - b.size[1]) / Math.max(a.size[1], 0.1),
    );
    errors.push(error);
    if (error >= Math.max(...errors)) {
      worstPosition = oracleZ;
      worstOracle = a.size[0];
      worstCandidate = b.size[0];
    }
  }
  const sorted = [...errors].sort((a, b) => a - b).slice(0, 12);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(sorted.length, 1);
  const score = Math.max(0, 100 - mean * 1000);
  return {
    code: "hull.station",
    component: "hull",
    view: "section-z",
    position: worstPosition,
    passed: score >= 90,
    score,
    severity: "critical",
    message: `hull stations score ${score.toFixed(1)}; worst width at z=${worstPosition.toFixed(3)}`,
    oracleValue: worstOracle,
    candidateValue: worstCandidate,
    deviation: worstCandidate - worstOracle,
    normalizedDeviation: mean,
  };
}

function curve(snapshot: SceneSnapshot, camera: CaptureCamera): CurvePoint[] {
  const frame = rasterizeCapture(snapshot, standardRenderProfile({ width: 128, height: 128 }), camera, "alpha-silhouette");
  return silhouetteCurves(frame).columns.map((column, index) => column ? [index, -column.top, -column.bottom] : null);
}

function curveRows(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow[] {
  const views: Array<{ id: "side" | "plan" | "front"; camera: CaptureCamera }> = [
    { id: "side", camera: { id: "side", projection: "orthographic", position: [12, 2, 0], target: [0, 0.8, 0] } },
    { id: "plan", camera: { id: "plan", projection: "orthographic", position: [0, 12, 0], target: [0, 0, 0] } },
    { id: "front", camera: { id: "front", projection: "orthographic", position: [0, 2, 12], target: [0, 0.8, 0] } },
  ];
  const oracleHull = filterSnapshot(oracle, (component) => component.id.startsWith("hull"));
  const candidateHull = filterSnapshot(candidate, (component) => component.id.startsWith("hull"));
  const oracleTurret = filterSnapshot(oracle, (component) => ["turret", "cupola"].includes(component.id));
  const candidateTurret = filterSnapshot(candidate, (component) => ["turret", "cupola"].includes(component.id));
  const hullScores = new Map<string, ReturnType<typeof scoreSilhouetteCurves>>();
  const wholeScores = new Map<string, ReturnType<typeof scoreSilhouetteCurves>>();
  const turretScores = new Map<string, ReturnType<typeof scoreSilhouetteCurves>>();
  for (const view of views) {
    const hull = scoreSilhouetteCurves(curve(oracleHull, view.camera), curve(candidateHull, view.camera), 128);
    hullScores.set(view.id, hull);
    wholeScores.set(view.id, scoreSilhouetteCurves(curve(oracle, view.camera), curve(candidate, view.camera), 128, hull.registration));
    if (view.id !== "front") {
      turretScores.set(view.id, scoreSilhouetteCurves(curve(oracleTurret, view.camera), curve(candidateTurret, view.camera), 128, hull.registration));
    }
  }
  const category = (code: string, component: string, scores: Map<string, ReturnType<typeof scoreSilhouetteCurves>>): GateRow => {
    const entries = [...scores.entries()];
    const worst = entries.sort(([, a], [, b]) => a.score - b.score)[0];
    const score = worst?.[1].score ?? 0;
    const column = worst?.[1].worst[0];
    return {
      code,
      component,
      ...(worst?.[0] ? { view: worst[0] } : {}),
      ...(column ? { position: column.position, oracleValue: column.oracleTop, candidateValue: column.candidateTop, deviation: column.candidateTop - column.oracleTop } : {}),
      passed: score >= 90,
      score,
      severity: "critical",
      message: `${component} curve floor ${score.toFixed(1)} in ${worst?.[0] ?? "unavailable"}; required 90`,
      normalizedDeviation: (100 - score) / 100,
    };
  };
  return [category("curves.hull", "hull", hullScores), category("curves.whole", "whole-vehicle", wholeScores), category("curves.turret", "turret", turretScores)];
}

function fabricationRow(candidate: SceneSnapshot): GateRow {
  const structural = Object.values(candidate.components)
    .filter((component) => ["hull", "hull-upper", "turret", "gun"].includes(component.id))
    .map((component) => component.id);
  const checks = checkWatertightness(candidate, structural);
  const boundaryEdges = checks.reduce((sum, check) => sum + check.boundaryEdges, 0);
  return {
    code: "fabrication.watertight",
    component: "major-masses",
    passed: checks.length === structural.length && boundaryEdges === 0,
    score: checks.length === structural.length && boundaryEdges === 0 ? 100 : 0,
    severity: "critical",
    message: `major-mass open boundary edges: ${boundaryEdges}`,
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

function floaterRow(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow {
  const turret = candidate.components.turret;
  const expectedOwned = Object.values(oracle.components).filter((component) =>
    component.parentSemanticId === "turret-pivot" || component.parentSemanticId === "gun-pivot");
  const failures = expectedOwned.filter((component) => {
    const actual = candidate.components[component.id];
    if (!actual || !turret) return true;
    return component.id !== "turret" && boundsGap(actual.bounds, turret.bounds) > 0.5;
  });
  return {
    code: "floaters.articulation",
    component: "turret-owned-components",
    passed: failures.length === 0,
    score: failures.length ? 0 : 100,
    severity: "critical",
    message: failures.length ? `detached or missing turret-owned components: ${failures.map((item) => item.id).join(", ")}` : "turret-owned components remain physically seated",
    oracleValue: 0,
    candidateValue: failures.length,
  };
}

export function evaluateTankProfile(oracle: SceneSnapshot, candidate: SceneSnapshot, options: TankOptions): GateReport {
  if (options.certification === "exact-real" && !options.authoritativeDimensions) {
    throw new Error("exact-real certification requires authoritative dimensions");
  }
  const rows: GateRow[] = [...curveRows(oracle, candidate), hullStationRow(oracle, candidate)];
  const oracleTurret = componentsBy(oracle, (component) => component.id === "turret" || component.id === "turret-pivot");
  const candidateTurret = componentsBy(candidate, (component) => component.id === "turret" || component.id === "turret-pivot");
  const turretOracleCenter = centerOf(oracleTurret);
  const turretCandidateCenter = centerOf(candidateTurret);
  rows.push(comparisonRow("turret.placement", "turret", turretOracleCenter[0], turretCandidateCenter[0], 0.01));

  const oracleGun = boundsOf(oracle, (component) => component.id === "gun");
  const candidateGun = boundsOf(candidate, (component) => component.id === "gun");
  rows.push(comparisonRow("gun.length", "gun", Math.max(...oracleGun.size), Math.max(...candidateGun.size), 0.01));

  const oracleWheels = componentsBy(oracle, (component) => component.role === "road-wheel" || component.id.startsWith("road-wheel-"));
  const candidateWheels = componentsBy(candidate, (component) => component.role === "road-wheel" || component.id.startsWith("road-wheel-"));
  const averageRadius = (items: SceneComponent[]): number => items.reduce((sum, item) => sum + Math.max(item.bounds.size[1], item.bounds.size[2]) / 2, 0) / Math.max(items.length, 1);
  const wheelCountPassed = oracleWheels.length === candidateWheels.length && oracleWheels.length > 0;
  rows.push({
    code: "running-gear.count",
    component: "road-wheels",
    passed: wheelCountPassed,
    score: wheelCountPassed ? 100 : 0,
    severity: "critical",
    message: `expected ${oracleWheels.length} road wheels, measured ${candidateWheels.length}`,
    oracleValue: oracleWheels.length,
    candidateValue: candidateWheels.length,
    deviation: candidateWheels.length - oracleWheels.length,
  });
  rows.push(comparisonRow("running-gear.radius", "road-wheels", averageRadius(oracleWheels), averageRadius(candidateWheels), 0.01));
  const centers = (items: SceneComponent[]): number[] => items.map((item) => item.bounds.center[2]).sort((a, b) => a - b);
  const spacingError = (a: number[], b: number[]): number => {
    if (a.length !== b.length || !a.length) return 1;
    return Math.max(...a.map((value, index) => Math.abs(value - (b[index] ?? value))));
  };
  const spacing = spacingError(centers(oracleWheels), centers(candidateWheels));
  rows.push({
    code: "running-gear.spacing",
    component: "road-wheels",
    passed: spacing <= 0.02,
    score: Math.max(0, 100 - spacing * 100),
    severity: "critical",
    message: `road-wheel maximum center displacement ${spacing.toFixed(4)} m`,
    oracleValue: 0,
    candidateValue: spacing,
    deviation: spacing,
    normalizedDeviation: spacing / Math.max(measureBounds(oracle).size[2], 1),
  });
  rows.push(fabricationRow(candidate), floaterRow(oracle, candidate));

  const oracleTracks = componentsBy(oracle, (component) => component.role === "track-course" || component.id.startsWith("track-"));
  const candidateTracks = componentsBy(candidate, (component) => component.role === "track-course" || component.id.startsWith("track-"));
  const trackCountPassed = oracleTracks.length === candidateTracks.length && oracleTracks.length >= 2;
  rows.push({
    code: "track.course",
    component: "track-course",
    passed: trackCountPassed,
    score: trackCountPassed ? 100 : 0,
    severity: "critical",
    message: `expected ${oracleTracks.length} track courses, measured ${candidateTracks.length}`,
    oracleValue: oracleTracks.length,
    candidateValue: candidateTracks.length,
  });

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
    const overall = measureBounds(candidate);
    rows.push(
      comparisonRow("dimensions.width", "whole-vehicle", options.authoritativeDimensions.width, overall.size[0], 0.01),
      comparisonRow("dimensions.height", "whole-vehicle", options.authoritativeDimensions.height, overall.size[1], 0.01),
      comparisonRow("dimensions.overall-length", "whole-vehicle", options.authoritativeDimensions.overallLength, overall.size[2], 0.01),
    );
  }
  const orientationPassed = oracle.metadata.forwardAxis === candidate.metadata.forwardAxis;
  rows.push({
    code: "orientation.forward",
    component: "whole-vehicle",
    passed: orientationPassed,
    score: orientationPassed ? 100 : 0,
    severity: "critical",
    message: `forward axis expected ${oracle.metadata.forwardAxis}, measured ${candidate.metadata.forwardAxis}`,
    oracleValue: oracle.metadata.forwardAxis ?? "unknown",
    candidateValue: candidate.metadata.forwardAxis ?? "unknown",
  });
  return {
    profile: "tank",
    passed: rows.every((row) => row.passed),
    score: Math.min(...rows.map((row) => row.score)),
    rows,
    workorders: rowsToWorkorders(rows),
  };
}

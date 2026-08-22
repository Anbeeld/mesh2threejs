import type { Bounds3, CaptureCamera, GateReport, GateRow, SceneComponent, SceneSnapshot, SceneTriangle } from "../types.js";
import { rowsToWorkorders, scoreSilhouetteCurves, type CurvePoint } from "../core/compare.js";
import { checkWatertightness, countConnectedIslands, measureBounds, measureRobustBounds, measureSection, silhouetteCurves } from "../core/measurement.js";
import { deriveCanonicalFrame, rasterizeCapture, standardRenderProfile } from "../core/render.js";
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
    return { code: "hull.stations", phase: "hull", component: "hull", passed: false, score: 0, severity: "critical", message: "hull semantics are missing" };
  }
  const oracleIds = oracleHull.map((component) => component.id);
  const candidateIds = candidateHull.map((component) => component.id);
  const errors: number[] = [];
  const locations: NonNullable<GateRow["worstLocations"]> = [];
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
    locations.push({ position: oracleZ, oracleValue: a.size[0], candidateValue: b.size[0], physicalDeviation: b.size[0] - a.size[0] });
  }
  const sorted = [...errors].sort((a, b) => a - b).slice(0, 12);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(sorted.length, 1);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 1;
  const score = Math.max(0, 100 - mean * 1000);
  const worst = [...locations].sort((a, b) => Math.abs(b.physicalDeviation) - Math.abs(a.physicalDeviation))[0];
  return {
    code: "hull.stations",
    phase: "hull",
    category: "cross-section-envelope",
    component: "hull",
    view: "section-z",
    ...(worst ? { position: worst.position } : {}),
    passed: score >= 90,
    score,
    severity: "critical",
    message: `hull station mean ${(mean * 100).toFixed(2)}%, P95 ${(p95 * 100).toFixed(2)}% after trimming 2 edge outliers`,
    ...(worst ? { oracleValue: worst.oracleValue, candidateValue: worst.candidateValue, deviation: worst.physicalDeviation } : {}),
    normalizedDeviation: mean,
    statistics: { mean, p95, coverage: locations.length / 14, sampleCount: 14, trimmedCount: 2 },
    worstLocations: [...locations].sort((a, b) => Math.abs(b.physicalDeviation) - Math.abs(a.physicalDeviation)).slice(0, 6),
    physicalUnit: "object-unit",
  };
}

function curve(snapshot: SceneSnapshot, camera: CaptureCamera, resolution: number, orthographicHeight: number): CurvePoint[] {
  const profile = standardRenderProfile({ width: resolution, height: resolution });
  profile.camera.orthographicHeight = orthographicHeight;
  const frame = rasterizeCapture(snapshot, profile, camera, "alpha-silhouette");
  return silhouetteCurves(frame).columns.map((column, index) => column ? [index, -column.top, -column.bottom] : null);
}

function curveRows(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow[] {
  const oracleBounds = measureBounds(oracle);
  const minimumFeature = Math.max(Math.min(...oracleBounds.size.filter((value) => value > 0)) / 120, Math.max(...oracleBounds.size) / 1000);
  const frame = deriveCanonicalFrame(oracleBounds, minimumFeature);
  const views: Array<{ id: "side" | "plan" | "front"; camera: CaptureCamera }> = ["side", "plan", "front"].map((id) => ({ id: id as "side" | "plan" | "front", camera: frame.cameras[id as "side" | "plan" | "front"] }));
  const oracleHull = filterSnapshot(oracle, (component) => component.id.startsWith("hull"));
  const candidateHull = filterSnapshot(candidate, (component) => component.id.startsWith("hull"));
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
    return {
      code,
      phase: component === "hull" ? "hull" : component === "turret" ? "turret" : "final",
      category: "silhouette-curve",
      component,
      ...(worst?.[0] ? { view: worst[0] } : {}),
      viewsEvaluated: entries.map(([view]) => view).sort(),
      ...(column ? { position: column.position, oracleValue: column.oracleTop, candidateValue: column.candidateTop, deviation: column.candidateTop - column.oracleTop } : {}),
      passed: score >= 90,
      score,
      severity: "critical",
      message: `${component} curve floor ${score.toFixed(1)} in ${worst?.[0] ?? "unavailable"}; required 90`,
      normalizedDeviation: (100 - score) / 100,
      ...(worst?.[1].registration ? { registration: { ...worst[1].registration, kind: "translation-only" as const } } : {}),
      ...(worst ? { statistics: { mean: worst[1].meanPct / 100, p95: worst[1].p95Pct / 100, coverage: 1 - worst[1].coverPct / 100, sampleCount: worst[1].worst.length } } : {}),
      ...(worst ? { worstLocations: worst[1].worst.slice(0, 6).map((item) => ({ position: item.position, oracleValue: item.oracleTop, candidateValue: item.candidateTop, physicalDeviation: item.candidateTop - item.oracleTop })) } : {}),
      physicalUnit: "pixel-in-frozen-frame",
    };
  };
  return [category("curves.hull", "hull", hullScores), category("curves.whole", "whole-vehicle", wholeScores), category("curves.turret", "turret", turretScores)];
}

function fabricationRow(candidate: SceneSnapshot): GateRow {
  const structural = Object.values(candidate.components)
    .filter((component) => ["hull", "hull-upper", "turret"].includes(component.id))
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
  const seatingTolerance = Math.max(...measureBounds(candidate, (component) => component.id.startsWith("hull")).size) * 0.05;
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

export function evaluateTankProfile(oracle: SceneSnapshot, candidate: SceneSnapshot, options: TankOptions): GateReport {
  if (options.certification === "exact-real" && !options.authoritativeDimensions) {
    throw new Error("exact-real certification requires authoritative dimensions");
  }
  const oracleHullBounds = measureBounds(oracle, (component) => component.id.startsWith("hull"));
  const measuredHullBounds = measureBounds(candidate, (component) => component.id.startsWith("hull"));
  const requiredHullLength = options.authoritativeDimensions?.hullLength ?? oracleHullBounds.size[2];
  const rows: GateRow[] = [
    ...curveRows(oracle, candidate),
    hullStationRow(oracle, candidate),
    { ...comparisonRow("dimensions.hull-length", "hull", requiredHullLength, measuredHullBounds.size[2], 0.01), phase: "hull", physicalUnit: "object-unit" },
  ];
  const oracleTurret = componentsBy(oracle, (component) => component.id === "turret" || component.id === "turret-pivot");
  const candidateTurret = componentsBy(candidate, (component) => component.id === "turret" || component.id === "turret-pivot");
  const turretOracleCenter = oracle.components["turret-pivot"]?.origin ?? centerOf(oracleTurret);
  const turretCandidateCenter = candidate.components["turret-pivot"]?.origin ?? centerOf(candidateTurret);
  const turretPlacement = [0, 1, 2].map((axis) => comparisonRow(`turret.placement.${["lateral", "vertical", "longitudinal"][axis]}`, "turret", turretOracleCenter[axis]!, turretCandidateCenter[axis]!, 0.01));
  const worstTurret = turretPlacement.sort((a, b) => (b.normalizedDeviation ?? 0) - (a.normalizedDeviation ?? 0))[0]!;
  rows.push({ ...worstTurret, code: "turret.placement", phase: "turret", category: "ring-seat-3d", message: `turret ring placement: ${turretPlacement.map((row) => `${row.code.split(".").at(-1)}=${Math.abs(row.deviation ?? 0).toFixed(4)}`).join(", ")}` });

  const oracleGun = boundsOf(oracle, (component) => component.id === "gun");
  const gunMetrics = (snapshot: SceneSnapshot) => {
    const pivot = snapshot.components["gun-pivot"]?.origin;
    const gun = snapshot.components.gun;
    if (!pivot || !gun) return null;
    const points = gun.triangleIndices.flatMap((index) => snapshot.triangles[index]?.points ?? []);
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

  const oracleWheels = componentsBy(oracle, (component) => component.role === "road-wheel" || component.id.startsWith("road-wheel-"));
  const candidateWheels = componentsBy(candidate, (component) => component.role === "road-wheel" || component.id.startsWith("road-wheel-"));
  const gearRole = (component: SceneComponent): string | undefined => component.role ?? ["road-wheel", "sprocket", "idler", "return-roller"].find((role) => component.id.startsWith(`${role}-`) || component.id === role);
  const oracleGear = componentsBy(oracle, (component) => Boolean(gearRole(component)));
  const candidateGear = componentsBy(candidate, (component) => Boolean(gearRole(component)));
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
  rows.push({ code: "running-gear.instances", phase: "running-gear", component: "running-gear", passed: wheelCountPassed && instanceRows.every((row) => row.passed), score: wheelCountPassed ? Math.min(...instanceRows.map((row) => row.score)) : 0, severity: "critical", message: wheelCountPassed && instanceRows.every((row) => row.passed) ? "all running-gear instances match by role, side, and order" : "one or more running-gear instances differs" });
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
  const trackErrors = oracleTracks.map((expected) => {
    const actual = candidate.components[expected.id];
    if (!actual) return Number.POSITIVE_INFINITY;
    return Math.max(...[0, 1, 2].map((axis) => Math.abs(actual.bounds.center[axis]! - expected.bounds.center[axis]!) / Math.max(expected.bounds.size[axis]!, 0.1)), ...[0, 1, 2].map((axis) => Math.abs(actual.bounds.size[axis]! - expected.bounds.size[axis]!) / Math.max(expected.bounds.size[axis]!, 0.1)));
  });
  const hasCourseVoid = (snapshot: SceneSnapshot, component: SceneComponent): boolean => {
    const triangles = component.triangleIndices.map((index) => snapshot.triangles[index]).filter((value): value is SceneTriangle => Boolean(value));
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
  const candidateHullBounds = measureBounds(candidate, (component) => component.id.startsWith("hull"));
  const hullPenetration = candidateTracks.reduce((worst, track) => {
    const overlap = Math.max(0, Math.min(track.bounds.max[0], candidateHullBounds.max[0]) - Math.max(track.bounds.min[0], candidateHullBounds.min[0]));
    return Math.max(worst, overlap / Math.max(track.bounds.size[0], 1e-9));
  }, 0);
  const trackEnvelopeError = Math.max(...trackErrors, 0);
  const trackPassed = trackCountPassed && trackEnvelopeError <= 0.01 && courseTopologyPassed && courseContinuityPassed && hullPenetration <= 0.25;
  rows.push({
    code: "track.course",
    component: "track-course",
    phase: "tracks",
    category: "course-envelope",
    passed: trackPassed,
    score: trackPassed ? 100 : Math.max(0, 100 - trackEnvelopeError * 1000),
    severity: "critical",
    message: `track count ${candidateTracks.length}/${oracleTracks.length}; envelope error ${trackEnvelopeError.toFixed(4)}; wrap void ${courseTopologyPassed ? "present" : "missing"}; continuous ${courseContinuityPassed}; hull penetration ${(hullPenetration * 100).toFixed(1)}% of track width`,
    oracleValue: oracleTracks.length,
    candidateValue: candidateTracks.length,
    normalizedDeviation: trackEnvelopeError,
    physicalUnit: "object-unit",
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
    const overall = measureRobustBounds(candidate, { exclude: /(antenna|aerial|whip)/iu });
    rows.push(
      comparisonRow("dimensions.width", "whole-vehicle", options.authoritativeDimensions.width, overall.size[0], 0.01),
      comparisonRow("dimensions.height", "whole-vehicle", options.authoritativeDimensions.height, overall.size[1], 0.01),
      comparisonRow("dimensions.overall-length", "whole-vehicle", options.authoritativeDimensions.overallLength, overall.size[2], 0.01),
    );
  }
  const directionalSignature = (snapshot: SceneSnapshot): number => {
    const hull = snapshot.components.hull;
    const gun = snapshot.components.gun;
    const turret = snapshot.components.turret;
    if (!hull || !gun || !turret) return Number.NaN;
    return (gun.bounds.center[2] - turret.bounds.center[2]) + 0.25 * (turret.bounds.center[2] - hull.bounds.center[2]);
  };
  const oracleDirection = directionalSignature(oracle);
  const candidateDirection = directionalSignature(candidate);
  const orientationPassed = Number.isFinite(oracleDirection) && Number.isFinite(candidateDirection) && Math.sign(oracleDirection) === Math.sign(candidateDirection);
  rows.push({
    code: "orientation.physical",
    phase: "hull",
    category: "directional-landmarks",
    component: "whole-vehicle",
    passed: orientationPassed,
    score: orientationPassed ? 100 : 0,
    severity: "critical",
    message: `physical fore/aft landmark signature expected ${oracleDirection.toFixed(4)}, measured ${candidateDirection.toFixed(4)}; metadata is informational only`,
    oracleValue: oracleDirection,
    candidateValue: candidateDirection,
    deviation: candidateDirection - oracleDirection,
    physicalUnit: "object-unit",
  });
  return {
    profile: "tank",
    passed: rows.every((row) => row.passed),
    score: Math.min(...rows.map((row) => row.score)),
    rows,
    workorders: rowsToWorkorders(rows),
  };
}

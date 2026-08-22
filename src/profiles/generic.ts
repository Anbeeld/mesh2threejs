import type { CaptureCamera, GateReport, GateRow, SceneComponent, SceneSnapshot } from "../types.js";
import { rowsToWorkorders, scoreSilhouetteCurves, type CurvePoint } from "../core/compare.js";
import { checkAttachments, countConnectedIslands, measureBounds, measureRobustBounds, measureSection, measureSignedVolume, silhouetteCurves } from "../core/measurement.js";
import { deriveCanonicalFrame, rasterizeCapture, standardRenderProfile } from "../core/render.js";
import { selectSnapshotComponents } from "../core/geometry.js";
import { getProfileContract } from "../core/contracts.js";

export interface GenericSubjectContract {
  requiredSemantics?: string[];
  criticalSemantics?: string[];
  attachments?: Array<{ child: string; parent: string; maxGap: number }>;
  sections?: Array<{ id: string; axis: "x" | "y" | "z"; fraction: number; semanticIds?: string[]; tolerance: number }>;
  landmarks?: Array<{ semanticId: string; tolerance: number }>;
  connectivity?: Array<{ semanticId: string; maxIslands: number }>;
  repeats?: Array<{ role: string; axis: "x" | "y" | "z"; tolerance: number }>;
  articulation?: Array<{ control: string; moving: string[]; stationary: string[]; samples: number[] }>;
  phaseOwnership?: Partial<Record<"primary-mass" | "attachments" | "identity-features", string[]>>;
  orientation?:
    | { kind: "landmark-direction"; from: string; to: string; toleranceDegrees: number }
    | { kind: "signed-volume"; minimumAbsoluteVolume?: number };
}

export interface GenericProfileOptions {
  certification?: "exact-real" | "oracle-relative";
  authoritativeDimensions?: { width: number; height: number; depth: number };
}

function metricRow(code: string, component: string, oracle: number, candidate: number, tolerance: number, severity: "critical" | "major" = "critical"): GateRow {
  const deviation = candidate - oracle;
  const normalizedDeviation = Math.abs(deviation) / Math.max(Math.abs(oracle), 1e-9);
  return {
    code,
    component,
    passed: normalizedDeviation <= tolerance,
    score: Math.max(0, 100 - normalizedDeviation * 1000),
    severity,
    message: `${component} expected ${oracle.toFixed(4)}, measured ${candidate.toFixed(4)}`,
    oracleValue: oracle,
    candidateValue: candidate,
    deviation,
    normalizedDeviation,
  };
}

function frameCurve(snapshot: SceneSnapshot, camera: CaptureCamera, resolution: number, orthographicHeight: number): CurvePoint[] {
  const profile = standardRenderProfile({ width: resolution, height: resolution });
  profile.camera.orthographicHeight = orthographicHeight;
  const frame = rasterizeCapture(snapshot, profile, camera, "alpha-silhouette");
  return silhouetteCurves(frame).columns.map((column, index) => column ? [index, -column.top, -column.bottom] : null);
}

function silhouetteRows(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow[] {
  const bounds = measureBounds(oracle);
  const minFeature = Math.max(Math.min(...bounds.size.filter((value) => value > 0)) / 100, Math.max(...bounds.size) / 1000);
  const frame = deriveCanonicalFrame(bounds, minFeature);
  const views: CaptureCamera[] = [frame.cameras.side, frame.cameras.front, frame.cameras.plan];
  return views.map((view) => {
    const score = scoreSilhouetteCurves(frameCurve(oracle, view, frame.width, frame.orthographicHeight), frameCurve(candidate, view, frame.width, frame.orthographicHeight), frame.width);
    return {
      code: `silhouette.${view.id}`,
      component: "whole-object",
      view: view.id,
      passed: score.score >= 90,
      score: score.score,
      severity: "critical",
      message: `${view.id} silhouette score ${score.score.toFixed(1)}; required 90`,
      oracleValue: 100,
      candidateValue: score.score,
      deviation: score.score - 100,
      normalizedDeviation: (100 - score.score) / 100,
      ...(score.registration ? { registration: { ...score.registration, kind: "translation-only" as const } } : {}),
      statistics: { mean: score.meanPct / 100, p95: score.p95Pct / 100, coverage: 1 - score.coverPct / 100, sampleCount: score.worst.length },
      physicalUnit: "pixel-in-frozen-frame",
    };
  });
}

function criticalRows(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow[] {
  return Object.values(oracle.components).filter((component) => component.critical).map((component) => {
    const present = Boolean(candidate.components[component.id]);
    return {
      code: `critical-feature.${component.id}`,
      component: component.id,
      passed: present,
      score: present ? 100 : 0,
      severity: "critical",
      message: present ? `${component.id} is present` : `restore critical feature ${component.id}`,
      oracleValue: "present",
      candidateValue: present ? "present" : "missing",
    };
  });
}

function primaryAttachment(snapshot: SceneSnapshot): Array<{ child: string; parent: string; maxGap: number }> {
  const semantics = getProfileContract("generic").semantics;
  const parent = semantics.required.find((id) => snapshot.components[id]);
  const child = semantics.optional.find((id) => snapshot.components[id]);
  return parent && child
    ? [{ child, parent, maxGap: 0.01 }]
    : [];
}

function semanticRows(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow[] {
  const semantics = getProfileContract("generic").semantics;
  return [...semantics.required, ...semantics.optional].filter((id) => Boolean(oracle.components[id])).map((id) => {
    const present = Boolean(candidate.components[id]);
    return {
      code: `semantic.${id}`,
      component: id,
      passed: present,
      score: present ? 100 : 0,
      severity: "critical",
      message: present ? `${id} semantic ownership is present` : `restore required ${id} semantic ownership`,
      oracleValue: "present",
      candidateValue: present ? "present" : "missing",
    };
  });
}

export function evaluateGenericProfile(oracle: SceneSnapshot, candidate: SceneSnapshot, contract: GenericSubjectContract = {}, options: GenericProfileOptions = {}): GateReport {
  const oracleBounds = measureRobustBounds(oracle);
  const candidateBounds = measureRobustBounds(candidate);
  if (options.certification === "exact-real" && !options.authoritativeDimensions) throw new Error("exact-real generic certification requires authoritative width, height, and depth");
  const dimensionKeys = ["width", "height", "depth"] as const;
  if (options.authoritativeDimensions && !dimensionKeys.every((key) => Number.isFinite(options.authoritativeDimensions?.[key]) && options.authoritativeDimensions![key] > 0)) throw new Error(`authoritative generic dimensions require ${dimensionKeys.join(", ")}`);
  if (options.authoritativeDimensions && Object.values(options.authoritativeDimensions).some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("authoritative generic dimensions must be positive finite values");
  const expectedDimensions = options.authoritativeDimensions ?? { width: oracleBounds.size[0], height: oracleBounds.size[1], depth: oracleBounds.size[2] };
  const dimensions = [
    metricRow("dimensions.width", "whole-object", expectedDimensions.width, candidateBounds.size[0], 0.01),
    metricRow("dimensions.height", "whole-object", expectedDimensions.height, candidateBounds.size[1], 0.01),
    metricRow("dimensions.depth", "whole-object", expectedDimensions.depth, candidateBounds.size[2], 0.01),
  ];
  const orientationMeasurement = (): { passed: boolean; expected: number; actual: number; message: string } => {
    if (contract.orientation?.kind === "signed-volume") {
      const expected = measureSignedVolume(oracle);
      const actual = measureSignedVolume(candidate);
      const minimum = contract.orientation.minimumAbsoluteVolume ?? 1e-9;
      const passed = Math.abs(expected) >= minimum && Math.abs(actual) >= minimum && Math.sign(expected) === Math.sign(actual);
      return { passed, expected, actual, message: `declared signed-volume orientation expected ${Math.sign(expected)}, measured ${Math.sign(actual)}` };
    }
    const declared = contract.orientation?.kind === "landmark-direction" ? contract.orientation : undefined;
    let from = declared?.from;
    let to = declared?.to;
    if (!from || !to) {
      const shared = Object.keys(oracle.components).filter((id) => candidate.components[id]);
      let bestDistance = 0;
      for (const a of shared) for (const b of shared) {
        const first = oracle.components[a]!.bounds.center;
        const second = oracle.components[b]!.bounds.center;
        const distance = Math.hypot(...first.map((value, axis) => value - second[axis]!));
        if (distance > bestDistance) { bestDistance = distance; from = a; to = b; }
      }
    }
    const expectedFrom = from ? oracle.components[from]?.bounds.center : undefined;
    const expectedTo = to ? oracle.components[to]?.bounds.center : undefined;
    const actualFrom = from ? candidate.components[from]?.bounds.center : undefined;
    const actualTo = to ? candidate.components[to]?.bounds.center : undefined;
    if (!expectedFrom || !expectedTo || !actualFrom || !actualTo) {
      return { passed: !declared, expected: 1, actual: declared ? -1 : 1, message: declared ? `declared orientation landmarks ${from ?? "<missing>"}/${to ?? "<missing>"} are unavailable` : "orientation is not physically distinguishable; declare directional landmarks when it matters" };
    }
    const expectedVector = expectedTo.map((value, axis) => value - expectedFrom[axis]!) as [number, number, number];
    const actualVector = actualTo.map((value, axis) => value - actualFrom[axis]!) as [number, number, number];
    const expectedLength = Math.hypot(...expectedVector);
    const actualLength = Math.hypot(...actualVector);
    if (expectedLength < 1e-9 || actualLength < 1e-9) return { passed: !declared, expected: 1, actual: 0, message: declared ? "declared orientation landmarks are coincident" : "orientation is not physically distinguishable; declare directional landmarks when it matters" };
    const cosine = expectedVector.reduce((sum, value, axis) => sum + value * actualVector[axis]!, 0) / (expectedLength * actualLength);
    const minimumCosine = Math.cos(((declared?.toleranceDegrees ?? 5) * Math.PI) / 180);
    return { passed: cosine >= minimumCosine, expected: 1, actual: cosine, message: `direction ${from}->${to} cosine ${cosine.toFixed(5)}; required ${minimumCosine.toFixed(5)}` };
  };
  const orientationValue = orientationMeasurement();
  const orientation: GateRow = {
    code: "orientation.physical",
    component: "whole-object",
    passed: orientationValue.passed,
    score: orientationValue.passed ? 100 : 0,
    severity: "critical",
    message: `${orientationValue.message}; metadata is informational only`,
    oracleValue: orientationValue.expected,
    candidateValue: orientationValue.actual,
    deviation: orientationValue.actual - orientationValue.expected,
  };
  const attachmentChecks = checkAttachments(candidate, contract.attachments ?? primaryAttachment(oracle));
  const attachments: GateRow[] = attachmentChecks.map((check) => ({
    code: "attachment.contiguity",
    component: check.child,
    passed: check.passed,
    score: check.passed ? 100 : 0,
    severity: "critical",
    message: `${check.child} to ${check.parent} gap ${check.gap.toFixed(4)}; max ${check.maxGap}`,
    oracleValue: check.maxGap,
    candidateValue: check.gap,
    deviation: check.gap - check.maxGap,
  }));
  const declaredSemantics = (contract.requiredSemantics ?? []).map((id): GateRow => ({ code: `semantic.${id}`, component: id, passed: Boolean(candidate.components[id]), score: candidate.components[id] ? 100 : 0, severity: "critical", message: candidate.components[id] ? `${id} semantic is present` : `restore declared semantic ${id}` }));
  const declaredCritical = (contract.criticalSemantics ?? []).map((id): GateRow => ({ code: `critical-feature.${id}`, component: id, passed: Boolean(candidate.components[id]), score: candidate.components[id] ? 100 : 0, severity: "critical", message: candidate.components[id] ? `${id} is present` : `restore declared critical feature ${id}` }));
  const sectionRows = (contract.sections ?? []).map((section): GateRow => {
    const captureSection = (snapshot: SceneSnapshot) => {
      const bounds = measureBounds(snapshot);
      const axis = section.axis === "x" ? 0 : section.axis === "y" ? 1 : 2;
      const position = bounds.min[axis] + bounds.size[axis] * section.fraction;
      return measureSection(snapshot, { axis: section.axis, position, thickness: Math.max(bounds.size[axis] / 200, 1e-6), ...(section.semanticIds ? { semanticIds: section.semanticIds } : {}) });
    };
    const expected = captureSection(oracle); const actual = captureSection(candidate);
    const error = Math.max(...[0, 1, 2].map((axis) => Math.abs(actual.size[axis]! - expected.size[axis]!) / Math.max(expected.size[axis]!, 1e-9)));
    return { code: `section.${section.id}`, component: section.id, passed: error <= section.tolerance, score: Math.max(0, 100 - error * 1000), severity: "critical", message: `${section.id} section error ${(error * 100).toFixed(2)}%`, normalizedDeviation: error };
  });
  const landmarkRows = (contract.landmarks ?? []).map((landmark): GateRow => {
    const expected = oracle.components[landmark.semanticId]?.bounds.center; const actual = candidate.components[landmark.semanticId]?.bounds.center;
    const error = expected && actual ? Math.hypot(...expected.map((value, axis) => value - actual[axis]!)) : Number.POSITIVE_INFINITY;
    return { code: `landmark.${landmark.semanticId}`, component: landmark.semanticId, passed: error <= landmark.tolerance, score: Number.isFinite(error) ? Math.max(0, 100 - error * 100) : 0, severity: "critical", message: `${landmark.semanticId} physical center error ${error}` };
  });
  const connectivityPolicy = contract.connectivity ?? (oracle.components.primary ? [{ semanticId: "primary", maxIslands: 1 }] : []);
  const connectivityRows = connectivityPolicy.map((item): GateRow => {
    const islands = countConnectedIslands(candidate, item.semanticId);
    return { code: `connectivity.${item.semanticId}`, component: item.semanticId, passed: islands > 0 && islands <= item.maxIslands, score: islands > 0 && islands <= item.maxIslands ? 100 : 0, severity: "critical", message: `${item.semanticId} has ${islands} connected islands; max ${item.maxIslands}` };
  });
  const repeatRows = (contract.repeats ?? []).map((item): GateRow => {
    const axis = { x: 0, y: 1, z: 2 }[item.axis] as 0 | 1 | 2;
    const expected = Object.values(oracle.components).filter((component) => component.role === item.role).sort((a, b) => a.bounds.center[axis] - b.bounds.center[axis]);
    const actual = Object.values(candidate.components).filter((component) => component.role === item.role).sort((a, b) => a.bounds.center[axis] - b.bounds.center[axis]);
    const passed = expected.length === actual.length && expected.every((component, index) => Math.abs(component.bounds.center[axis] - actual[index]!.bounds.center[axis]) <= item.tolerance);
    return { code: `repeat.${item.role}`, component: item.role, passed, score: passed ? 100 : 0, severity: "critical", message: `${item.role} repeat count/order ${actual.length}/${expected.length}` };
  });
  const rows = [...dimensions, orientation, ...silhouetteRows(oracle, candidate), ...semanticRows(oracle, candidate), ...attachments, ...criticalRows(oracle, candidate), ...declaredSemantics, ...declaredCritical, ...sectionRows, ...landmarkRows, ...connectivityRows, ...repeatRows];
  return {
    profile: "generic",
    passed: rows.every((row) => row.passed),
    score: Math.min(...rows.map((row) => row.score)),
    rows,
    workorders: rowsToWorkorders(rows),
  };
}

export function filterSnapshot(snapshot: SceneSnapshot, filter: (component: SceneComponent) => boolean): SceneSnapshot {
  return selectSnapshotComponents(snapshot, filter);
}

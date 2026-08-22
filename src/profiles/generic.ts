import type { CaptureCamera, GateReport, GateRow, SceneComponent, SceneSnapshot } from "../types.js";
import { rowsToWorkorders, scoreSilhouetteCurves, type CurvePoint } from "../core/compare.js";
import { checkAttachments, measureBounds, silhouetteCurves } from "../core/measurement.js";
import { rasterizeCapture, standardRenderProfile } from "../core/render.js";

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

function frameCurve(snapshot: SceneSnapshot, camera: CaptureCamera): CurvePoint[] {
  const frame = rasterizeCapture(snapshot, standardRenderProfile({ width: 128, height: 128 }), camera, "alpha-silhouette");
  return silhouetteCurves(frame).columns.map((column, index) => column ? [index, -column.top, -column.bottom] : null);
}

function silhouetteRows(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow[] {
  const views: CaptureCamera[] = [
    { id: "side", projection: "orthographic", position: [12, 2, 0], target: [0, 0, 0] },
    { id: "front", projection: "orthographic", position: [0, 2, 12], target: [0, 0, 0] },
    { id: "plan", projection: "orthographic", position: [0, 12, 0], target: [0, 0, 0] },
  ];
  return views.map((view) => {
    const score = scoreSilhouetteCurves(frameCurve(oracle, view), frameCurve(candidate, view), 128);
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
  return snapshot.components.attachment && snapshot.components.primary
    ? [{ child: "attachment", parent: "primary", maxGap: 0.01 }]
    : [];
}

function semanticRows(oracle: SceneSnapshot, candidate: SceneSnapshot): GateRow[] {
  return ["primary", "attachment"].filter((id) => Boolean(oracle.components[id])).map((id) => {
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

export function evaluateGenericProfile(oracle: SceneSnapshot, candidate: SceneSnapshot): GateReport {
  const oracleBounds = measureBounds(oracle);
  const candidateBounds = measureBounds(candidate);
  const dimensions = [
    metricRow("dimensions.width", "whole-object", oracleBounds.size[0], candidateBounds.size[0], 0.01),
    metricRow("dimensions.height", "whole-object", oracleBounds.size[1], candidateBounds.size[1], 0.01),
    metricRow("dimensions.depth", "whole-object", oracleBounds.size[2], candidateBounds.size[2], 0.01),
  ];
  const orientationPassed = oracle.metadata.forwardAxis === candidate.metadata.forwardAxis;
  const orientation: GateRow = {
    code: "orientation.forward",
    component: "whole-object",
    passed: orientationPassed,
    score: orientationPassed ? 100 : 0,
    severity: "critical",
    message: `forward axis expected ${oracle.metadata.forwardAxis ?? "unknown"}, measured ${candidate.metadata.forwardAxis ?? "unknown"}`,
    oracleValue: oracle.metadata.forwardAxis ?? "unknown",
    candidateValue: candidate.metadata.forwardAxis ?? "unknown",
  };
  const attachmentChecks = checkAttachments(candidate, primaryAttachment(oracle));
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
  const rows = [...dimensions, orientation, ...silhouetteRows(oracle, candidate), ...semanticRows(oracle, candidate), ...attachments, ...criticalRows(oracle, candidate)];
  return {
    profile: "generic",
    passed: rows.every((row) => row.passed),
    score: Math.min(...rows.map((row) => row.score)),
    rows,
    workorders: rowsToWorkorders(rows),
  };
}

export function filterSnapshot(snapshot: SceneSnapshot, filter: (component: SceneComponent) => boolean): SceneSnapshot {
  const components = Object.fromEntries(Object.entries(snapshot.components).filter(([, component]) => filter(component)));
  const ids = new Set(Object.keys(components));
  const triangles = snapshot.triangles.filter((triangle) => ids.has(triangle.componentId));
  return {
    ...snapshot,
    components,
    triangles,
    triangleCount: triangles.length,
    meshCount: Object.keys(components).length,
  };
}

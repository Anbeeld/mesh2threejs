import type { GateRow, Severity, Workorder } from "../types.js";

export type CurvePoint = readonly [number, number, number] | null;

export interface CurveScore {
  score: number;
  meanPct: number;
  p95Pct: number;
  coverPct: number;
  registration?: { dAlong: number; vertical: number };
  worst: Array<{ position: number; oracleTop: number; oracleBottom: number; candidateTop: number; candidateBottom: number; error: number }>;
}

function span(curve: readonly CurvePoint[], bodyOnly: boolean): [number, number] | null {
  const valid = curve.filter((point): point is Exclude<CurvePoint, null> => point !== null);
  if (!valid.length) return null;
  let selected = valid;
  if (bodyOnly) {
    const rough = Math.max(...valid.map((point) => point[1])) - Math.min(...valid.map((point) => point[2]));
    const body = valid.filter((point) => point[1] - point[2] > rough * 0.12);
    if (body.length) selected = body;
  }
  return [selected[0]?.[0] ?? 0, selected[selected.length - 1]?.[0] ?? 0];
}

function percentile95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

export function scoreSilhouetteCurves(
  oracle: readonly CurvePoint[],
  candidate: readonly CurvePoint[],
  normalizationDimension: number,
  fixedRegistration?: { dAlong: number; vertical: number },
): CurveScore {
  const oracleSpan = span(oracle, false);
  const candidateSpan = span(candidate, false);
  const oracleBody = span(oracle, true) ?? oracleSpan;
  const candidateBody = span(candidate, true) ?? candidateSpan;
  if (!oracleSpan || !candidateSpan || !oracleBody || !candidateBody || normalizationDimension <= 0) {
    return { score: 0, meanPct: 100, p95Pct: 100, coverPct: 100, worst: [] };
  }
  const dAlong = fixedRegistration?.dAlong
    ?? (oracleBody[0] + oracleBody[1]) / 2 - (candidateBody[0] + candidateBody[1]) / 2;
  const validCandidate = candidate.filter((point): point is Exclude<CurvePoint, null> => point !== null);
  const interpolate = (along: number): Exclude<CurvePoint, null> | null => {
    const target = along - dAlong;
    if (target < candidateSpan[0] - 0.02 || target > candidateSpan[1] + 0.02) return null;
    let lower: Exclude<CurvePoint, null> | null = null;
    let upper: Exclude<CurvePoint, null> | null = null;
    for (const point of validCandidate) {
      if (point[0] <= target && (!lower || point[0] > lower[0])) lower = point;
      if (point[0] >= target && (!upper || point[0] < upper[0])) upper = point;
    }
    if (!upper && lower && target - lower[0] <= 0.02) return [target, lower[1], lower[2]];
    if (!lower && upper && upper[0] - target <= 0.02) return [target, upper[1], upper[2]];
    if (!lower || !upper) return null;
    if (upper[0] === lower[0]) return lower;
    const ratio = (target - lower[0]) / (upper[0] - lower[0]);
    return [target, lower[1] + (upper[1] - lower[1]) * ratio, lower[2] + (upper[2] - lower[2]) * ratio];
  };
  let vertical = fixedRegistration?.vertical ?? 0;
  if (!fixedRegistration) {
    let total = 0;
    let count = 0;
    for (const point of oracle) {
      if (!point) continue;
      const paired = interpolate(point[0]);
      if (!paired) continue;
      total += ((point[1] + point[2]) - (paired[1] + paired[2])) / 2;
      count += 1;
    }
    vertical = count ? total / count : 0;
  }
  const oraclePitch = oracle.reduce<{ previous: number | null; pitch: number }>((state, point) => {
    if (!point || state.pitch) return state;
    if (state.previous !== null) return { previous: point[0], pitch: Math.abs(point[0] - state.previous) };
    return { previous: point[0], pitch: 0 };
  }, { previous: null, pitch: 0 }).pitch;
  const margin = Math.max(0.05, oraclePitch * 0.75);
  let either = 0;
  let onlyOne = 0;
  for (const point of candidate) {
    if (!point) continue;
    either += 1;
    const registered = point[0] + dAlong;
    if (registered < oracleSpan[0] - margin || registered > oracleSpan[1] + margin) onlyOne += 1;
  }
  const errors: number[] = [];
  const worst: CurveScore["worst"] = [];
  for (const point of oracle) {
    if (!point) continue;
    either += 1;
    const paired = interpolate(point[0]);
    if (!paired) {
      onlyOne += 1;
      continue;
    }
    const candidateTop = paired[1] + vertical;
    const candidateBottom = paired[2] + vertical;
    const error = (Math.abs(point[1] - candidateTop) + Math.abs(point[2] - candidateBottom)) / 2;
    errors.push(error);
    worst.push({
      position: point[0],
      oracleTop: point[1],
      oracleBottom: point[2],
      candidateTop,
      candidateBottom,
      error,
    });
  }
  if (!errors.length) return { score: 0, meanPct: 100, p95Pct: 100, coverPct: 100, worst: [] };
  const meanPct = (errors.reduce((sum, value) => sum + value, 0) / errors.length / normalizationDimension) * 100;
  const p95Pct = (percentile95(errors) / normalizationDimension) * 100;
  const coverPct = either ? (onlyOne / either) * 100 : 0;
  const score = Math.max(0, Math.min(100, 100 - 12 * meanPct - 0.6 * p95Pct - 1.5 * coverPct));
  return {
    score,
    meanPct,
    p95Pct,
    coverPct,
    registration: { dAlong, vertical },
    worst: worst.sort((a, b) => b.error - a.error).slice(0, 12),
  };
}

export function rowsToWorkorders(rows: GateRow[]): Workorder[] {
  const severityOrder: Record<Severity, number> = { critical: 0, major: 1, minor: 2 };
  return rows
    .filter((row) => !row.passed)
    .map((row) => ({
      component: row.component,
      ...(row.view ? { view: row.view } : {}),
      ...(row.position !== undefined ? { position: row.position } : {}),
      ...(row.oracleValue !== undefined ? { oracleValue: row.oracleValue } : {}),
      ...(row.candidateValue !== undefined ? { candidateValue: row.candidateValue } : {}),
      ...(row.deviation !== undefined ? { absoluteDeviation: Math.abs(row.deviation) } : {}),
      ...(row.normalizedDeviation !== undefined ? { normalizedDeviation: Math.abs(row.normalizedDeviation) } : {}),
      errorKind: row.code,
      priority: row.severity,
      correction: row.message,
    }))
    .sort((a, b) => severityOrder[a.priority] - severityOrder[b.priority] || (b.normalizedDeviation ?? 0) - (a.normalizedDeviation ?? 0));
}

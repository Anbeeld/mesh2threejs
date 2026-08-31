import { describe, expect, test } from "vitest";
import { compareFailingTiers, resolveSeedOutcome, type DeriveTierResult } from "../src/index.js";

/**
 * Bundle A regression (continuation plan §5): failing-tier retention must rank by diagnostic
 * usefulness (required gates passed, mean gate score, worst fidelity score, then complexity)
 * instead of the shared phase-minimum score, which collapses to zero for every tier when one
 * binary gate (e.g. connectivity) blocks them all.
 */

const tier = (overrides: Partial<DeriveTierResult> & { tier: DeriveTierResult["tier"] }): DeriveTierResult => ({
  triangles: 1000,
  passed: false,
  score: 0,
  ...overrides,
});

describe("failing-tier diagnostic retention (bundle A)", () => {
  test("shared binary zero row: source-preserve with better diagnostics is retained over aggressive", () => {
    const aggressive = tier({
      tier: "componentwise-aggressive",
      score: 0,
      diagnostic: { passedGateCount: 1, gateCount: 5, meanGateScore: 24, minFidelityGateScore: 24 },
    });
    const sourcePreserve = tier({
      tier: "source-preserve",
      score: 0,
      diagnostic: { passedGateCount: 4, gateCount: 5, meanGateScore: 88, minFidelityGateScore: 80 },
    });
    const outcome = resolveSeedOutcome([aggressive, sourcePreserve]);
    expect(outcome.status).toBe("seed-retained-failing");
    expect(outcome.chosen?.tier).toBe("source-preserve");
  });

  test("a tier passing more required gates is retained even with a lower mean score", () => {
    const broad = tier({
      tier: "componentwise-aggressive",
      diagnostic: { passedGateCount: 4, gateCount: 5, meanGateScore: 40, minFidelityGateScore: 10 },
    });
    const deep = tier({
      tier: "source-preserve",
      diagnostic: { passedGateCount: 3, gateCount: 5, meanGateScore: 70, minFidelityGateScore: 60 },
    });
    expect(resolveSeedOutcome([deep, broad]).chosen?.tier).toBe("componentwise-aggressive");
  });

  test("exact diagnostic tie falls back to lower triangle count", () => {
    const heavy = tier({ tier: "componentwise-conservative", triangles: 5000, diagnostic: { passedGateCount: 2, gateCount: 5, meanGateScore: 50, minFidelityGateScore: 30 } });
    const light = tier({ tier: "componentwise-aggressive", triangles: 900, diagnostic: { passedGateCount: 2, gateCount: 5, meanGateScore: 50, minFidelityGateScore: 30 } });
    expect(resolveSeedOutcome([heavy, light]).chosen?.tier).toBe("componentwise-aggressive");
  });

  test("a passing tier always wins before any failing tier regardless of diagnostics", () => {
    const passing = tier({ tier: "source-preserve", passed: true, score: 92, diagnostic: { passedGateCount: 5, gateCount: 5, meanGateScore: 92, minFidelityGateScore: 90 } });
    const failingBetterDiag = tier({ tier: "componentwise-aggressive", diagnostic: { passedGateCount: 5, gateCount: 6, meanGateScore: 95, minFidelityGateScore: 95 } });
    const outcome = resolveSeedOutcome([failingBetterDiag, passing]);
    expect(outcome.status).toBe("seed-passing");
    expect(outcome.chosen?.tier).toBe("source-preserve");
  });

  test("compareFailingTiers is a strict total order over the documented criteria", () => {
    const a = tier({ tier: "componentwise-aggressive", diagnostic: { passedGateCount: 2, gateCount: 4, meanGateScore: 50, minFidelityGateScore: 20 } });
    const b = tier({ tier: "source-preserve", diagnostic: { passedGateCount: 2, gateCount: 4, meanGateScore: 60, minFidelityGateScore: 10 } });
    expect(compareFailingTiers(a, b)).toBeGreaterThan(0);
    expect(compareFailingTiers(b, a)).toBeLessThan(0);
  });

  test("tiers without diagnostics keep the legacy score-then-triangles behavior", () => {
    const first = tier({ tier: "componentwise-aggressive", score: 40 });
    const second = tier({ tier: "source-preserve", score: 70 });
    expect(resolveSeedOutcome([first, second]).chosen?.tier).toBe("source-preserve");
    const tieA = tier({ tier: "componentwise-aggressive", score: 0, triangles: 3000 });
    const tieB = tier({ tier: "source-preserve", score: 0, triangles: 1200 });
    expect(resolveSeedOutcome([tieA, tieB]).chosen?.tier).toBe("source-preserve");
  });
});
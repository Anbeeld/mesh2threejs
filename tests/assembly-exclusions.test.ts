import { describe, expect, test } from "vitest";
import { validateAssemblyExclusions, type AssemblyExclusion } from "../src/core/oracle.js";

describe("durable assembly exclusions (release host-trust closure §7)", () => {
  const semanticMap = {
    "node:0": "hull",
    "node:1": "turret-pivot",
    "node:2": "turret",
    "node:3": "gun-pivot",
    "node:4": "gun",
    "node:5": "display-stand",
  };

  test("valid exclusion for a non-subject element passes", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:5", kind: "non-subject", reason: "display stand" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, semanticMap)).not.toThrow();
  });

  test("exclusion with unknown nodeId is rejected", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:99", kind: "non-subject", reason: "unknown" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, semanticMap)).toThrow(/does not resolve/);
  });

  test("exclusion without a reason is rejected", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:5", kind: "non-subject", reason: "" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, semanticMap)).toThrow(/requires a reason/);
  });

  test("required semantics cannot be excluded", () => {
    const required = ["hull", "turret", "gun", "turret-pivot", "gun-pivot"];
    for (const semantic of required) {
      const nodeId = Object.entries(semanticMap).find(([, v]) => v === semantic)![0];
      const exclusions: AssemblyExclusion[] = [
        { nodeId, kind: "non-subject", reason: "attempt to exclude required" },
      ];
      expect(() => validateAssemblyExclusions(exclusions, semanticMap)).toThrow(/cannot be excluded/);
    }
  });

  test("presentation-fixture and microdetail kinds are allowed", () => {
    const exclusions: AssemblyExclusion[] = [
      { nodeId: "node:5", kind: "presentation-fixture", reason: "presentation floor" },
    ];
    expect(() => validateAssemblyExclusions(exclusions, semanticMap)).not.toThrow();
  });
});
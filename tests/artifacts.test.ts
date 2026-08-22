import { describe, expect, test } from "vitest";
import { validateRepositoryArtifacts } from "../src/validation/artifacts.js";

describe("repository artifact validation", () => {
  test("compiles shipped schemas and validates presets, profiles, adapters, and skills", async () => {
    const result = await validateRepositoryArtifacts(process.cwd());
    expect(result.errors).toEqual([]);
    expect(result.validated).toBeGreaterThanOrEqual(18);
  });
});

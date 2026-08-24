import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Control-text regression (remaining closure §8.6): instruction surfaces must describe the
 * CURRENT trusted workflow. Obsolete authority phrases and trusted-mode command routes fail
 * the suite instead of relying on humans noticing drift.
 */

const SURFACES = [
  "SKILL.md",
  "AGENTS.md",
  "tools/COMMANDS.md",
  "skills/reconstruct/SKILL.md",
  "skills/build/SKILL.md",
  "skills/diagnose/SKILL.md",
  "skills/visual-review/SKILL.md",
  "skills/finalize/SKILL.md",
  "skills/onboard-oracle/SKILL.md",
  "skills/repair-oracle/SKILL.md",
];

/** Phrases that must never appear in any instruction surface. */
const GLOBAL_FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /external-vision verdict/iu, why: "external/model verdicts are diagnostics, never certification authority" },
  { pattern: /repairs\/[^\s`)"']*\.mjs/iu, why: "executable repair modules are refused in trusted derived runs; repairs are declarative JSON specs" },
  { pattern: /export function repair/iu, why: "repair code snippets teach executable repairs" },
];

/** Phrases that must not appear in skills a trusted reconstruction builder follows. */
const BUILDER_SKILL_FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\brebind\b/iu, why: "trusted policy drift requires an administrative rebase/new run, never builder rebind" },
  { pattern: /local procedural repair/iu, why: "derived-mode repairs are declarative JSON specs compiled by derive" },
];

const BUILDER_SKILLS = [
  "skills/reconstruct/SKILL.md",
  "skills/build/SKILL.md",
  "skills/diagnose/SKILL.md",
  "skills/visual-review/SKILL.md",
  "skills/finalize/SKILL.md",
];

describe("agent control text describes the trusted workflow (§8)", () => {
  test("every declared surface exists", async () => {
    for (const surface of SURFACES) {
      await expect(readFile(join(surface), "utf8"), `${surface} is missing`).resolves.toBeTruthy();
    }
  });

  test("no obsolete authority phrases anywhere", async () => {
    for (const surface of SURFACES) {
      const text = await readFile(surface, "utf8");
      for (const rule of [...GLOBAL_FORBIDDEN, ...(BUILDER_SKILLS.includes(surface) ? BUILDER_SKILL_FORBIDDEN : [])]) {
        expect(rule.pattern.test(text), `${surface} contains forbidden text (${rule.why})`).toBe(false);
      }
    }
  });

  test("declarative repair guidance names the spec schema path", async () => {
    const build = await readFile("skills/build/SKILL.md", "utf8");
    expect(build).toMatch(/model\/repairs\/<active-phase>\.json/);
    expect(build).toMatch(/schemas\/derived-repair\.v1\.json/);
    const root = await readFile("SKILL.md", "utf8");
    expect(root).toMatch(/schemas\/derived-repair\.v1\.json/);
  });

  test("human approval authority wording is present in root + review skill", async () => {
    const root = await readFile("SKILL.md", "utf8");
    expect(root).toMatch(/HUMAN approval/i);
    const review = await readFile("skills/visual-review/SKILL.md", "utf8");
    expect(review).toMatch(/diagnostic data only/iu);
  });
});

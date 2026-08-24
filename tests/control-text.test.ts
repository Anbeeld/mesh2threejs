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
  { pattern: /CLI is the authoritative mutation surface/iu, why: "broker is the trusted authority surface; CLI is development-only" },
  { pattern: /\bmesh2threejs rebind\b/iu, why: "trusted policy drift requires an administrative rebase/new run, never builder rebind" },
];

/** Unscoped trusted CLI command routes that must not appear outside a DEVELOPMENT MODE section. */
const UNSCoped_CLI_FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /mesh2threejs derive\b/iu, why: "trusted mode uses broker derive, not raw CLI" },
  { pattern: /mesh2threejs gate\b/iu, why: "trusted mode uses broker gate, not raw CLI" },
  { pattern: /mesh2threejs review-ready\b/iu, why: "trusted mode uses broker review-ready, not raw CLI" },
  { pattern: /mesh2threejs render\b[^\n]*--quick/iu, why: "trusted mode uses broker render-quick, not raw CLI" },
  { pattern: /mesh2threejs finalize\b/iu, why: "trusted mode uses broker trusted-finalize, not raw CLI" },
];

const BUILDER_SKILLS = [
  "skills/reconstruct/SKILL.md",
  "skills/build/SKILL.md",
  "skills/diagnose/SKILL.md",
  "skills/visual-review/SKILL.md",
  "skills/finalize/SKILL.md",
];

/**
 * Extract the "trusted" portion of a file: everything except lines under a
 * `## DEVELOPMENT MODE` heading (until the next `##` heading or end of file).
 * Unscoped CLI routes are allowed only inside the DEVELOPMENT MODE section.
 */
function trustedPortion(text: string): string {
  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  let inDevSection = false;
  for (const line of lines) {
    if (/^##\s+DEVELOPMENT MODE/iu.test(line)) { inDevSection = true; continue; }
    if (/^##\s+/u.test(line) && inDevSection) { inDevSection = false; }
    if (!inDevSection) result.push(line);
  }
  return result.join("\n");
}

describe("agent control text describes the trusted workflow (§8)", () => {
  test("every declared surface exists", async () => {
    for (const surface of SURFACES) {
      await expect(readFile(join(surface), "utf8"), `${surface} is missing`).resolves.toBeTruthy();
    }
  });

  test("no obsolete authority phrases anywhere", async () => {
    for (const surface of SURFACES) {
      const text = await readFile(surface, "utf8");
      for (const rule of GLOBAL_FORBIDDEN) {
        expect(rule.pattern.test(text), `${surface} contains forbidden text (${rule.why})`).toBe(false);
      }
    }
  });

  test("no unscoped trusted CLI routes outside DEVELOPMENT MODE sections", async () => {
    for (const surface of SURFACES) {
      const text = await readFile(surface, "utf8");
      const trusted = trustedPortion(text);
      for (const rule of UNSCoped_CLI_FORBIDDEN) {
        expect(rule.pattern.test(trusted), `${surface} contains unscoped CLI route (${rule.why})`).toBe(false);
      }
    }
  });

  test("positive broker routing wording is present", async () => {
    const root = await readFile("SKILL.md", "utf8");
    expect(root).toMatch(/trusted run.*broker/iu);
    const commands = await readFile("tools/COMMANDS.md", "utf8");
    expect(commands).toMatch(/Trusted reconstruction authority surface = broker/iu);
    expect(commands).toMatch(/Development mutation surface = CLI/iu);
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

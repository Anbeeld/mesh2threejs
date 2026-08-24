import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("host packaging and progressive disclosure", () => {
  test("ignores every repository-local workspace as one boundary", async () => {
    const ignore = await readFile(".gitignore", "utf8");
    expect(ignore).toContain("/workspaces/");
    expect(ignore).not.toMatch(/workspaces\/\*\//u);
  });

  test.each(["reconstruct", "onboard-oracle", "repair-oracle", "build", "visual-review", "diagnose", "finalize"])("packages valid %s role metadata", async (role) => {
    const root = process.cwd();
    const skill = await readFile(join(root, "skills", role, "SKILL.md"), "utf8");
    const metadata = await readFile(join(root, "skills", role, "agents", "openai.yaml"), "utf8");
    expect(skill).toMatch(new RegExp(`^---\\r?\\nname: ${role}\\r?\\n`));
    expect(skill).not.toContain("TODO");
    expect(metadata).toContain(`$${role}`);
  });

  test("documents host compatibility without inert adapter manifests", async () => {
    const root = process.cwd();
    const hostCompat = await readFile(join(root, "docs", "host-compatibility.md"), "utf8");
    for (const host of ["Codex Desktop", "Claude Code", "OpenCode"]) {
      expect(hostCompat).toContain(host);
    }
    expect(existsSync(join(root, "adapters"))).toBe(false);
  });

  test("root router does not activate tank instructions for generic tasks", async () => {
    const router = await readFile(join(process.cwd(), "SKILL.md"), "utf8");
    expect(router.length).toBeLessThan(3000);
    expect(router).toContain("otherwise use `profiles/generic/`");
    expect(router).not.toContain("14 hull stations");
  });
});

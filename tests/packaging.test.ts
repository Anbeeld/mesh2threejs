import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("host packaging and progressive disclosure", () => {
  test.each(["reconstruct", "onboard-oracle", "repair-oracle", "build", "critic", "diagnose", "finalize"])("packages valid %s role metadata", async (role) => {
    const root = process.cwd();
    const skill = await readFile(join(root, "skills", role, "SKILL.md"), "utf8");
    const metadata = await readFile(join(root, "skills", role, "agents", "openai.yaml"), "utf8");
    expect(skill).toMatch(new RegExp(`^---\\r?\\nname: ${role}\\r?\\n`));
    expect(skill).not.toContain("TODO");
    expect(metadata).toContain(`$${role}`);
  });

  test("marks unexecuted hosts as unverified and retains a proven critic path", async () => {
    const root = process.cwd();
    const codex = JSON.parse(await readFile(join(root, "adapters", "codex", "adapter.json"), "utf8"));
    const claude = JSON.parse(await readFile(join(root, "adapters", "claude-code", "adapter.json"), "utf8"));
    const opencode = JSON.parse(await readFile(join(root, "adapters", "opencode", "adapter.json"), "utf8"));
    expect(codex.capabilities.separateProcessCritic).toBe(true);
    expect(claude.status).toContain("not-installed");
    expect(opencode.status).toContain("not-installed");
    expect(claude.capabilities.projectInstructionDiscovery).toBe(false);
  });

  test("root router does not activate tank instructions for generic tasks", async () => {
    const router = await readFile(join(process.cwd(), "SKILL.md"), "utf8");
    expect(router.length).toBeLessThan(3000);
    expect(router).toContain("otherwise use `profiles/generic/`");
    expect(router).not.toContain("14 hull stations");
  });
});

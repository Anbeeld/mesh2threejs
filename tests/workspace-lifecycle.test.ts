import { access, cp, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createTaskState,
  bindOracle,
  createWorkspaceResolver,
  initializeWorkspace,
  migrateWorkspace,
  resumeWorkspace,
  saveTaskState,
  sha256,
} from "../src/index.js";

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function writeReference(directory: string, name: string, contents: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

const baseProject = { id: "portable", goal: "Reconstruct the reference", profile: "generic" as const };

describe("self-contained workspace lifecycle", () => {
  test("initializes the canonical empty layout without mixing user and pipeline files", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "mesh2threejs-empty-")), "workspace");
    const result = await initializeWorkspace(root, baseProject);
    expect(result.project).toMatchObject({ oracle: null, model: "model/model.mjs", referenceMode: "copy", portable: true });
    for (const path of [
      "project.json", "refs/oracle", "refs/images", "refs/docs", "model/model.mjs",
      ".mesh2threejs/state.json", ".mesh2threejs/oracle/cache", ".mesh2threejs/evidence",
      ".mesh2threejs/reports", ".mesh2threejs/captures", ".mesh2threejs/visual-review", ".mesh2threejs/locks",
    ]) expect(await exists(join(root, path))).toBe(true);
    expect(await exists(join(root, "task.json"))).toBe(false);
    expect(await exists(join(root, "state.json"))).toBe(false);
  });

  test("adopts one pre-created oracle and rejects ambiguous discovery without writing metadata", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-adopt-"));
    const root = join(parent, "single");
    await writeReference(join(root, "refs", "oracle"), "subject.glb", "oracle-a");
    const adopted = await initializeWorkspace(root, baseProject);
    expect(adopted.project.oracle).toBe("refs/oracle/subject.glb");

    const ambiguous = join(parent, "ambiguous");
    await writeReference(join(ambiguous, "refs", "oracle"), "a.glb", "a");
    await writeReference(join(ambiguous, "refs", "oracle"), "b.glb", "b");
    await expect(initializeWorkspace(ambiguous, baseProject)).rejects.toThrow(/multiple oracle/i);
    expect(await exists(join(ambiguous, "project.json"))).toBe(false);

    const selected = join(parent, "selected");
    const first = await writeReference(join(parent, "sources"), "first.glb", "first");
    const second = await writeReference(join(parent, "sources"), "second.glb", "second");
    const initialized = await initializeWorkspace(selected, { ...baseProject, oracle: second, references: [first] });
    expect(initialized.project.oracle).toBe("refs/oracle/second.glb");
  });

  test("imports arbitrary oracle, image, and document paths with verified relative records", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-import-"));
    const sources = join(parent, "sources");
    const oracle = await writeReference(sources, "subject.glb", "oracle-bytes");
    const image = await writeReference(sources, "front.png", "image-bytes");
    const document = await writeReference(sources, "dimensions.json", JSON.stringify({ dimensions: { height: { exclude: ["antenna*"] } } }));
    const root = join(parent, "workspace");
    const result = await initializeWorkspace(root, { ...baseProject, references: [oracle, image], subjectContract: document });
    expect(result.project).toMatchObject({
      oracle: "refs/oracle/subject.glb",
      images: ["refs/images/front.png"],
      documents: ["refs/docs/dimensions.json"],
      subjectContract: "refs/docs/dimensions.json",
      portable: true,
    });
    expect((await resumeWorkspace(root)).resolved.subjectContract).toBe(join(root, "refs", "docs", "dimensions.json"));
    const index = JSON.parse(await readFile(join(root, ".mesh2threejs", "references.json"), "utf8")) as { records: Array<{ operationalPath: string; originalPath: string; sha256: string }> };
    expect(index.records).toHaveLength(3);
    for (const record of index.records) {
      expect(record.operationalPath).not.toMatch(/^[A-Za-z]:[\\/]/u);
      expect(isAbsolute(record.originalPath)).toBe(true);
      expect(sha256(await readFile(join(root, record.operationalPath)))).toBe(record.sha256);
    }
  });

  test("reuses equal collisions and gives differing files a deterministic hash suffix", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-collision-"));
    const first = await writeReference(join(parent, "a"), "view.png", "same");
    const equal = await writeReference(join(parent, "b"), "view.png", "same");
    const different = await writeReference(join(parent, "c"), "view.png", "different");
    const root = join(parent, "workspace");
    const result = await initializeWorkspace(root, { ...baseProject, references: [first, equal, different] });
    expect(result.project.images).toHaveLength(2);
    expect(result.project.images).toContain("refs/images/view.png");
    expect(result.project.images).toContain(`refs/images/view-${sha256("different").slice(0, 8)}.png`);
    expect(await readFile(join(root, "refs", "images", "view.png"), "utf8")).toBe("same");
  });

  test("keeps external references explicit and fails resume when one disappears", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-external-"));
    const oracle = await writeReference(parent, "subject.glb", "external-oracle");
    const root = join(parent, "workspace");
    const initialized = await initializeWorkspace(root, { ...baseProject, oracle, referenceMode: "external" });
    expect(initialized.project).toMatchObject({ oracle: resolve(oracle), referenceMode: "external", portable: false });
    expect((await resumeWorkspace(root)).resolved.oracle).toBe(resolve(oracle));
    await rename(oracle, `${oracle}.missing`);
    await expect(resumeWorkspace(root)).rejects.toThrow(/missing reference/i);
    await rename(`${oracle}.missing`, oracle);
    await writeFile(oracle, "changed-external-oracle");
    await expect(resumeWorkspace(root)).rejects.toThrow(/hash changed/i);
  });

  test("resumes after relocation and rejects workspace-relative path escape", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-relocate-"));
    const oracle = await writeReference(join(parent, "sources"), "subject.glb", "portable-oracle");
    const original = join(parent, "original");
    await initializeWorkspace(original, { ...baseProject, oracle });
    const relocated = join(parent, "relocated");
    await cp(original, relocated, { recursive: true });
    const resumed = await resumeWorkspace(relocated);
    expect(resumed.resolved.oracle).toBe(join(relocated, "refs", "oracle", "subject.glb"));
    expect(resumed.nextAction.route).toBe("onboard-oracle");
    expect(() => createWorkspaceResolver(relocated).resolveProjectPath("../escape.glb")).toThrow(/escapes workspace/i);
  });

  test("does not publish project metadata when a required import fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-transaction-"));
    const valid = await writeReference(parent, "valid.glb", "valid");
    const root = join(parent, "workspace");
    await expect(initializeWorkspace(root, { ...baseProject, references: [valid, join(parent, "missing.png")] })).rejects.toThrow(/reference/i);
    expect(await exists(join(root, "project.json"))).toBe(false);
  });

  test("migrates the legacy root layout into model and pipeline-owned directories", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mesh2threejs-migrate-"));
    const root = join(parent, "legacy");
    const oracle = await writeReference(join(parent, "sources"), "legacy.glb", "legacy-oracle");
    await mkdir(join(root, "candidate"), { recursive: true });
    await mkdir(join(root, "evidence"), { recursive: true });
    await writeFile(join(root, "candidate", "candidate.mjs"), "export function createCandidate() {}\n");
    await writeFile(join(root, "evidence", "old.json"), "{}\n");
    await writeFile(join(root, "task.json"), `${JSON.stringify({ schemaVersion: 1, id: "legacy", goal: "Legacy project", profile: "generic", style: "low-poly-faithful", oracleManifest: "oracle/manifest.json", candidateModule: "candidate/candidate.mjs", certification: "oracle-relative" })}\n`);
    await saveTaskState(join(root, "state.json"), bindOracle(createTaskState({ taskId: "legacy", profile: "generic", style: "low-poly-faithful" }), "legacy-oracle-hash"));
    const migrated = await migrateWorkspace(root, { oracle });
    expect(migrated.project.model).toBe("model/candidate.mjs");
    expect(await exists(join(root, "model", "candidate.mjs"))).toBe(true);
    expect(await exists(join(root, ".mesh2threejs", "state.json"))).toBe(true);
    expect(await exists(join(root, ".mesh2threejs", "evidence", "old.json"))).toBe(true);
    expect(await exists(join(root, "task.json"))).toBe(false);
    expect(await exists(join(root, "candidate"))).toBe(false);
    expect((await resumeWorkspace(root)).state.oracleHash).toBeNull();
  });
});

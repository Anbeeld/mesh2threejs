import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CertificationLevel, ProfileId } from "../types.js";
import { createTaskState, saveTaskState } from "./state.js";

export interface TaskManifest {
  schemaVersion: 1;
  id: string;
  goal: string;
  profile: ProfileId;
  style: string;
  oracleManifest: string;
  candidateModule: string;
  certification: CertificationLevel;
}

export async function initializeWorkspace(directory: string, task: Omit<TaskManifest, "schemaVersion">): Promise<{ root: string; directories: string[] }> {
  const root = resolve(directory);
  const directories = ["oracle", "candidate", "evidence", "reports", "captures", "critic"];
  await mkdir(root, { recursive: true });
  await Promise.all(directories.map((name) => mkdir(join(root, name), { recursive: true })));
  const manifest: TaskManifest = { schemaVersion: 1, ...task };
  await writeFile(join(root, "task.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  await saveTaskState(join(root, "state.json"), createTaskState({ taskId: task.id, profile: task.profile, style: task.style, certification: task.certification }));
  return { root, directories };
}

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { loadProfileContract, validateProfileContract } from "../core/contracts.js";
import { evaluateCandidateWithPoses } from "../core/orchestration.js";
import { analyticalGeneric, analyticalTank } from "../fixtures/analytical.js";

export interface ArtifactValidationResult {
  validated: number;
  errors: string[];
}

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function validateRepositoryArtifacts(root: string): Promise<ArtifactValidationResult> {
  const base = resolve(root);
  const errors: string[] = [];
  let validated = 0;
  const schemaNames = ["project-manifest.v1.json", "reference-index.v1.json", "oracle-manifest.v1.json", "render-profile.v1.json"];
  for (const name of schemaNames) {
    try {
      new Ajv2020({ strict: true }).compile(await jsonFile(join(base, "schemas", name)) as AnySchema);
      validated += 1;
    } catch (error) {
      errors.push(`${name}: ${String(error)}`);
    }
  }
  try {
    const schema = await jsonFile(join(base, "styles", "SCHEMA.json"));
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as AnySchema);
    const preset = await jsonFile(join(base, "styles", "low-poly-faithful.json"));
    if (!validate(preset)) errors.push(`low-poly-faithful.json: ${JSON.stringify(validate.errors)}`);
    validated += 2;
  } catch (error) {
    errors.push(`style artifacts: ${String(error)}`);
  }
  for (const profile of ["generic", "tank"]) {
    try {
      const contract = await loadProfileContract(profile as "generic" | "tank");
      const result = validateProfileContract(contract);
      if (!result.valid) errors.push(`${profile}/contract.json: ${result.errors.join("; ")}`);
      const oracle = profile === "tank" ? analyticalTank() : analyticalGeneric();
      const candidate = profile === "tank" ? analyticalTank() : analyticalGeneric();
      const turret = candidate.getObjectByName("turret-pivot");
      const gun = candidate.getObjectByName("gun-pivot");
      const execution = await evaluateCandidateWithPoses({
        oracle,
        candidate: {
          root: candidate,
          setPose: ({ turretYaw, gunElevation }) => {
            if (turret) turret.rotation.y = turretYaw;
            if (gun) gun.rotation.x = gunElevation;
            candidate.updateMatrixWorld(true);
          },
        },
        profile: profile as "generic" | "tank",
      });
      if (!execution.contractGates.passed) errors.push(`${profile}/contract.json: runtime gate drift: ${execution.contractGates.rows.filter((row) => !row.passed).map((row) => row.message).join("; ")}`);
      validated += 1;
    } catch (error) { errors.push(`${profile}/contract.json: ${String(error)}`); }
  }
  for (const host of ["codex", "claude-code", "opencode"]) {
    try {
      const adapter = await jsonFile(join(base, "adapters", host, "adapter.json")) as { host?: unknown; status?: unknown; capabilities?: { actualVisualReview?: unknown } };
      if (typeof adapter.host !== "string" || typeof adapter.status !== "string" || typeof adapter.capabilities?.actualVisualReview !== "boolean") {
        errors.push(`${host} adapter has an invalid capability contract`);
      }
      validated += 1;
    } catch (error) {
      errors.push(`${host} adapter: ${String(error)}`);
    }
  }
  const skillRoots = [base, ...["reconstruct", "onboard-oracle", "repair-oracle", "build", "visual-review", "diagnose", "finalize"].map((name) => join(base, "skills", name))];
  for (const skillRoot of skillRoots) {
    try {
      const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
      if (!/^---\r?\n/u.test(skill) || skill.includes("TODO")) errors.push(`${skillRoot}: incomplete SKILL.md`);
      validated += 1;
    } catch (error) { errors.push(`${skillRoot}: ${String(error)}`); }
  }
  return { validated, errors };
}

async function main(): Promise<void> {
  const result = await validateRepositoryArtifacts(process.cwd());
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

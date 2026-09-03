import type { ConstructionMode } from "../types.js";

/**
 * Construction-mode routing (stylized-authored mode design §5). The selected mode is part of
 * the project configuration identity and therefore of the trusted run policy: switching it
 * requires a new evidence chain / rebind, never a silent mid-run change. Routing is enforced
 * by trusted code below — it is never a prose-only convention.
 */

export const CONSTRUCTION_MODES: ReadonlySet<ConstructionMode> = new Set(["derived-faithful", "stylized-authored"]);

/** Legacy default: every pre-mode workspace and run behaves exactly as before. */
export const DEFAULT_CONSTRUCTION_MODE: ConstructionMode = "derived-faithful";

export function isConstructionMode(value: unknown): value is ConstructionMode {
  return typeof value === "string" && CONSTRUCTION_MODES.has(value as ConstructionMode);
}

/** Normalizes a project/state field that may be absent on legacy artifacts. */
export function effectiveConstructionMode(value: ConstructionMode | null | undefined): ConstructionMode {
  return value ?? DEFAULT_CONSTRUCTION_MODE;
}

/**
 * Named routing failure codes (design §5.2/§44). Trusted operations throw these so the
 * builder surface can explain WHY an operation is unavailable instead of failing vaguely.
 */
export type ConstructionRoutingCode =
  | "MODE_FORBIDS_DERIVATION"
  | "MODE_FORBIDS_SOURCE_DERIVED_REPAIR"
  | "MODE_REQUIRES_AUTHORED_SPEC"
  | "STYLE_BINDING_REQUIRED"
  | "AUTHOR_SPEC_INVALID"
  | "AUTHORING_FROZEN"
  | "FREEZE_STALE"
  | "REFERENCE_SCENE_STALE"
  | "ORACLE_REFERENCE_IMPORT_FORBIDDEN"
  | "STYLIZED_COPY_DETECTED"
  | "VISUAL_CHECKPOINT_REQUIRED"
  | "CONSTRUCTION_MODE_INVALID";

export class ConstructionRoutingError extends Error {
  constructor(readonly code: ConstructionRoutingCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = "ConstructionRoutingError";
  }
}

/** Trusted derived construction operations, by mode (design §5.2/§26). */
export function deriveAllowedIn(mode: ConstructionMode): boolean {
  return mode === "derived-faithful";
}

/** Declarative repair operations mutate source-derived seeds; stylized authoring never routes through them for final geometry. */
export function sourceDerivedRepairsAllowedIn(mode: ConstructionMode): boolean {
  return mode === "derived-faithful";
}

/** Authored-spec compilation is the stylized candidate construction route. */
export function authoredCompilationRequiredIn(mode: ConstructionMode): boolean {
  return mode === "stylized-authored";
}

/**
 * Workspace-relative path prefixes a stylized candidate must never import or read. The
 * oracle/reference-view trees are trusted comparison data, never candidate construction
 * material (design invariant 2/§11.3).
 */
export const CANDIDATE_FORBIDDEN_PATH_PREFIXES: ReadonlyArray<string> = [
  "refs/",
  ".mesh2threejs/oracle",
  ".mesh2threejs/reference-view",
  "model/.generated/",
  ".generated/",
];

export function candidateImportViolation(specifier: string): string | null {
  const normalized = specifier.replaceAll("\\", "/").toLowerCase();
  for (const prefix of CANDIDATE_FORBIDDEN_PATH_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.includes(`/${prefix}`) || normalized.includes(`../${prefix}`) || normalized.includes(`.${prefix}`)) {
      return prefix;
    }
  }
  return null;
}
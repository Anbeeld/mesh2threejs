import type * as THREE from "three";

/**
 * Single authoritative source-geometry disposition classifier. Both assembly coverage
 * evaluation and fidelity snapshot filtering consume this module, so the two can never
 * drift. Kept dependency-neutral (type-only THREE import) so any core module may import
 * it without import cycles.
 */

export type OracleGeometryDisposition = "subject" | "subject-microdetail" | "non-subject";

/**
 * Returns the disposition of a mesh based on ancestor-chain exclusion markers.
 * `non-subject` and `presentation-fixture` kinds → `non-subject`.
 * `microdetail` kind → `subject-microdetail`.
 * No exclusion marker → `subject`.
 * An `insignificant` marker without a known kind → `non-subject` (safe default).
 */
export function oracleGeometryDisposition(mesh: THREE.Object3D): OracleGeometryDisposition {
  let current: THREE.Object3D | null = mesh;
  let disposition: OracleGeometryDisposition = "subject";
  while (current) {
    if (current.userData.insignificant === true) {
      const kind = current.userData.exclusionKind as string | undefined;
      if (kind === "non-subject" || kind === "presentation-fixture") {
        disposition = "non-subject";
      } else if (kind === "microdetail") {
        if (disposition === "subject") disposition = "subject-microdetail";
      } else {
        // insignificant without a known kind — treat as non-subject for safety.
        if (disposition === "subject") disposition = "non-subject";
      }
    }
    current = current.parent;
  }
  return disposition;
}

/** True if the mesh is non-subject and must be excluded from ALL subject measurement/derivation. */
export function isNonSubject(mesh: THREE.Object3D): boolean {
  return oracleGeometryDisposition(mesh) === "non-subject";
}

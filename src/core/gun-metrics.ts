/**
 * Shared tessellation-invariant gun barrel measurement.
 *
 * Used by BOTH the gun.geometry evaluator (profiles/tank.ts) and the axis-fit gun seed
 * (core/derive.ts) so the two can never drift: the evaluator measures exactly what the
 * seed builder constructs.
 *
 * Invariance properties:
 * - The axis is the dominant direction of an AREA-WEIGHTED surface covariance (exact
 *   per-triangle covariance integrated over each triangle), so subdividing one region of
 *   the barrel more finely than another does not change the axis. Plain vertex-count
 *   covariance would weight a 100-triangle patch 10x more than the same physical patch
 *   tessellated as 10 triangles.
 * - The length is the maximum axial projection of the barrel vertices from the pivot. For
 *   any barrel (cylinder, prism, any radial segment count, any angular phase) the muzzle
 *   rim projects to the same axial coordinate, so the length is tessellation-invariant.
 * - The radial extent is the maximum perpendicular distance from the axis, reported as an
 *   independent quantity (own gate row) rather than being conflated with length or axis.
 */
import type { Point3, SceneSnapshot } from "../types.js";

export interface GunBarrelMetrics {
  /** Gun-pivot origin (measurement origin). */
  pivot: Point3;
  /** Unit barrel axis, oriented so the axial projection of the gun grows away from the pivot. */
  axis: Point3;
  /** Maximum axial projection of any gun vertex from the pivot. */
  length: number;
  /** Maximum perpendicular distance of any gun vertex from the axis line through the pivot. */
  radialExtent: number;
}

interface SurfaceTriangle {
  area: number;
  centroid: [number, number, number];
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
}

/**
 * Area-weighted surface covariance of the gun mesh, computed exactly per triangle:
 * for each triangle, A·(c-μ)(c-μ)ᵀ contributes the parallel-axis term and
 * (A/12)·Σᵢ(vᵢ-c)(vᵢ-c)ᵀ the triangle's own second moment about its centroid.
 * Returns the dominant axis together with the AREA-WEIGHTED surface mean, so the caller's
 * orientation decision uses the same weighted reference as the axis itself (a raw
 * duplicated-vertex average would let uneven tessellation flip the sign).
 */
function surfaceCovarianceAxis(points: Array<[number, number, number]>): { axis: [number, number, number]; mean: [number, number, number] } | null {
  if (points.length < 3) return null;
  let totalArea = 0;
  let areaTimesCentroid: [number, number, number] = [0, 0, 0];
  // One record per surviving triangle: centroid/area AND its own vertices. Filtering
  // degenerate triangles into parallel arrays would misalign the second-moment term's vertex
  // lookup (entry t of a filtered list belongs to a different triangle than points[t*3..]).
  const triangles: SurfaceTriangle[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    const a = points[i]!, b = points[i + 1]!, c = points[i + 2]!;
    const abx = b[0]! - a[0]!, aby = b[1]! - a[1]!, abz = b[2]! - a[2]!;
    const acx = c[0]! - a[0]!, acy = c[1]! - a[1]!, acz = c[2]! - a[2]!;
    const cx = aby * acz - abz * acy, cy = abz * acx - abx * acz, cz = abx * acy - aby * acx;
    const area = Math.hypot(cx, cy, cz) / 2;
    if (!(area > 1e-12)) continue;
    const centroid: [number, number, number] = [(a[0]! + b[0]! + c[0]!) / 3, (a[1]! + b[1]! + c[1]!) / 3, (a[2]! + b[2]! + c[2]!) / 3];
    totalArea += area;
    areaTimesCentroid[0]! += area * centroid[0]!;
    areaTimesCentroid[1]! += area * centroid[1]!;
    areaTimesCentroid[2]! += area * centroid[2]!;
    triangles.push({ area, centroid, a, b, c });
  }
  if (!(totalArea > 1e-9)) return null;
  const mean: [number, number, number] = [areaTimesCentroid[0]! / totalArea, areaTimesCentroid[1]! / totalArea, areaTimesCentroid[2]! / totalArea];
  const covariance: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const { area, centroid, a, b, c } of triangles) {
    const dc = [centroid[0]! - mean[0]!, centroid[1]! - mean[1]!, centroid[2]! - mean[2]!];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) covariance[i]![j]! += area * dc[i]! * dc[j]!;
    // The triangle's own second moment about its centroid: (A/12)Σᵢ(vᵢ-c)(vᵢ-c)ᵀ.
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (const v of [a, b, c]) { const dv = [v[0]! - centroid[0]!, v[1]! - centroid[1]!, v[2]! - centroid[2]!]; sum += dv[i]! * dv[j]!; }
      covariance[i]![j]! += (area / 12) * sum;
    }
  }
  // Start the power iteration from the covariance diagonal rather than a fixed vector: a
  // start vector exactly parallel to a NON-dominant eigenvector (e.g. [0,0,1] against a
  // barrel that is exactly symmetric about z) is a fixed point and never converges to the
  // dominant axis. The diagonal of a barrel covariance is dominated by the axial variance,
  // which breaks the symmetry deterministically.
  const diagonalNorm = Math.hypot(covariance[0]![0]!, covariance[1]![1]!, covariance[2]![2]!);
  let axis: [number, number, number] = diagonalNorm > 1e-12
    ? [covariance[0]![0]! / diagonalNorm, covariance[1]![1]! / diagonalNorm, covariance[2]![2]! / diagonalNorm]
    : [0, 0, 1];
  for (let iteration = 0; iteration < 96; iteration += 1) {
    const next: [number, number, number] = [
      covariance[0]![0]! * axis[0]! + covariance[0]![1]! * axis[1]! + covariance[0]![2]! * axis[2]!,
      covariance[1]![0]! * axis[0]! + covariance[1]![1]! * axis[1]! + covariance[1]![2]! * axis[2]!,
      covariance[2]![0]! * axis[0]! + covariance[2]![1]! * axis[1]! + covariance[2]![2]! * axis[2]!,
    ];
    const norm = Math.hypot(...next);
    if (!(norm > 1e-12)) return null;
    axis = next.map((value) => value / norm) as [number, number, number];
  }
  return { axis, mean };
}

export function measureGunGeometry(snapshot: SceneSnapshot): GunBarrelMetrics | null {
  const pivot = snapshot.components["gun-pivot"]?.origin;
  const gun = snapshot.components.gun;
  if (!pivot || !gun || !gun.triangleIndices.length) return null;
  const points: Array<[number, number, number]> = [];
  const positions = snapshot.triangleData.positions;
  for (const localIndex of gun.triangleIndices) {
    const offset = localIndex * 9;
    if (offset + 9 > positions.length) continue;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      points.push([positions[offset + vertex * 3]!, positions[offset + vertex * 3 + 1]!, positions[offset + vertex * 3 + 2]!]);
    }
  }
  if (points.length < 3) return null;
  const measured = surfaceCovarianceAxis(points);
  if (!measured) return null;
  let axis = measured.axis;
  // Orientation against the AREA-WEIGHTED surface mean (the same reference the covariance
  // uses): a raw duplicated-vertex average would tilt with uneven tessellation and could
  // flip the axis sign for meshes whose material sits close to the pivot.
  const centroidVector: Point3 = [measured.mean[0]! - pivot[0], measured.mean[1]! - pivot[1], measured.mean[2]! - pivot[2]];
  if (centroidVector[0]! * axis[0]! + centroidVector[1]! * axis[1]! + centroidVector[2]! * axis[2]! < 0) {
    axis = axis.map((value) => -value) as Point3;
  }
  let length = 0;
  let radialExtent = 0;
  for (const point of points) {
    const d = [point[0]! - pivot[0]!, point[1]! - pivot[1]!, point[2]! - pivot[2]!];
    const axial = d[0]! * axis[0]! + d[1]! * axis[1]! + d[2]! * axis[2]!;
    if (axial > length) length = axial;
    const radial = Math.sqrt(Math.max(d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]! - axial * axial, 0));
    if (radial > radialExtent) radialExtent = radial;
  }
  return { pivot: [...pivot] as Point3, axis, length, radialExtent };
}

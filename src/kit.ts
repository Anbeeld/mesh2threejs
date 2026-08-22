import * as THREE from "three";

export interface LoftStation {
  z: number;
  halfWidth: number;
  bottom: number;
  top: number;
}

/** Four-corner hard-surface loft ordered left-bottom, right-bottom, right-top, left-top. */
export function createLoftGeometry(stations: LoftStation[]): THREE.BufferGeometry {
  if (stations.length < 2) throw new Error("loft requires at least two stations");
  const ordered = [...stations].sort((a, b) => a.z - b.z);
  for (const station of ordered) {
    if (![station.z, station.halfWidth, station.bottom, station.top].every(Number.isFinite) || station.halfWidth <= 0 || station.top <= station.bottom) {
      throw new Error("loft station dimensions are invalid");
    }
  }
  const positions = ordered.flatMap((station) => [
    -station.halfWidth, station.bottom, station.z,
    station.halfWidth, station.bottom, station.z,
    station.halfWidth, station.top, station.z,
    -station.halfWidth, station.top, station.z,
  ]);
  const indices: number[] = [];
  for (let station = 0; station < ordered.length - 1; station += 1) {
    const a = station * 4;
    const b = (station + 1) * 4;
    for (let side = 0; side < 4; side += 1) {
      const next = (side + 1) % 4;
      indices.push(a + side, b + side, b + next, a + side, b + next, a + next);
    }
  }
  const last = (ordered.length - 1) * 4;
  indices.push(0, 2, 1, 0, 3, 2, last, last + 1, last + 2, last, last + 2, last + 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

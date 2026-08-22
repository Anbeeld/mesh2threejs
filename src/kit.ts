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

export function createPlate(width: number, height: number, thickness: number): THREE.BoxGeometry {
  if (![width, height, thickness].every((value) => Number.isFinite(value) && value > 0)) throw new Error("plate dimensions must be positive");
  return new THREE.BoxGeometry(width, height, thickness);
}

export function createPrism(width: number, height: number, depth: number, taper = 0): THREE.BufferGeometry {
  if (![width, height, depth].every((value) => Number.isFinite(value) && value > 0) || Math.abs(taper) >= 1) throw new Error("prism parameters are invalid");
  return createLoftGeometry([
    { z: -depth / 2, halfWidth: width * (1 - taper) / 2, bottom: -height / 2, top: height / 2 },
    { z: depth / 2, halfWidth: width * (1 + taper) / 2, bottom: -height / 2, top: height / 2 },
  ]);
}

export function createFrustum(bottomRadius: number, topRadius: number, height: number, segments = 12): THREE.CylinderGeometry {
  if (bottomRadius <= 0 || topRadius < 0 || height <= 0 || segments < 3) throw new Error("frustum parameters are invalid");
  return new THREE.CylinderGeometry(topRadius, bottomRadius, height, segments, 1, false);
}

export interface RadialLoftStation { y: number; radius: number }

export function createRadialLoftGeometry(stations: RadialLoftStation[], segments = 12): THREE.LatheGeometry {
  if (stations.length < 2 || segments < 3 || stations.some((station) => station.radius < 0 || !Number.isFinite(station.y))) throw new Error("radial loft parameters are invalid");
  return new THREE.LatheGeometry(stations.map((station) => new THREE.Vector2(station.radius, station.y)), segments);
}

export function createTube(radius: number, length: number, radialSegments = 8, openEnded = false): THREE.CylinderGeometry {
  if (radius <= 0 || length <= 0 || radialSegments < 3) throw new Error("tube parameters are invalid");
  return new THREE.CylinderGeometry(radius, radius, length, radialSegments, 1, openEnded);
}

export function createWheel(radius: number, width: number, segments = 10): THREE.CylinderGeometry {
  return createTube(radius, width, segments, false);
}

export function repeatParts<T extends THREE.Object3D>(count: number, spacing: number, factory: (index: number) => T): THREE.Group {
  if (!Number.isInteger(count) || count < 1 || !Number.isFinite(spacing)) throw new Error("repeat parameters are invalid");
  const group = new THREE.Group();
  for (let index = 0; index < count; index += 1) {
    const part = factory(index);
    part.position.z += (index - (count - 1) / 2) * spacing;
    group.add(part);
  }
  return group;
}

export function createTrackCourseGeometry(length: number, height: number, width: number, wrapRadius: number): THREE.ExtrudeGeometry {
  if ([length, height, width, wrapRadius].some((value) => !Number.isFinite(value) || value <= 0) || wrapRadius * 2 >= Math.min(length, height)) throw new Error("track course parameters are invalid");
  const outer = new THREE.Shape();
  outer.moveTo(-length / 2, -height / 2);
  outer.lineTo(length / 2, -height / 2);
  outer.lineTo(length / 2, height / 2);
  outer.lineTo(-length / 2, height / 2);
  outer.closePath();
  const inner = new THREE.Path();
  const inset = Math.min(width, wrapRadius * 0.6);
  inner.moveTo(-length / 2 + inset, -height / 2 + inset);
  inner.lineTo(-length / 2 + inset, height / 2 - inset);
  inner.lineTo(length / 2 - inset, height / 2 - inset);
  inner.lineTo(length / 2 - inset, -height / 2 + inset);
  inner.closePath();
  outer.holes.push(inner);
  const geometry = new THREE.ExtrudeGeometry(outer, { depth: width, bevelEnabled: false, curveSegments: 4, steps: 1 });
  geometry.translate(0, 0, -width / 2);
  geometry.rotateY(Math.PI / 2);
  return geometry;
}

export function createFitting(id: string, geometry: THREE.BufferGeometry, role: "hatch" | "fender" | "fitting" = "fitting"): THREE.Mesh {
  if (!id.trim()) throw new Error("fitting requires a semantic id");
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x66705a, roughness: 0.72 }));
  mesh.name = id;
  mesh.userData.semanticId = id;
  mesh.userData.semanticRole = role;
  return mesh;
}

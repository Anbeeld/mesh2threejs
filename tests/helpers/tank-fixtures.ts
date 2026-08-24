import * as THREE from "three";
import { createLoftGeometry, createTrackCourseGeometry } from "../../src/kit.js";

/** Splits every triangle at its centroid into three; identical geometry, denser topology. */
export function tessellateFiner(geometry: THREE.BufferGeometry, times = 1): THREE.BufferGeometry {
  let current = geometry.toNonIndexed();
  for (let iteration = 0; iteration < times; iteration += 1) {
    const position = current.getAttribute("position") as THREE.BufferAttribute;
    const positions = new Float32Array(position.count * 9);
    for (let triangle = 0; triangle < position.count / 3; triangle += 1) {
      const read = (vertex: number): [number, number, number] => [position.getX(triangle * 3 + vertex), position.getY(triangle * 3 + vertex), position.getZ(triangle * 3 + vertex)];
      const a = read(0);
      const b = read(1);
      const c = read(2);
      const centroid: [number, number, number] = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      const output: Array<[number, number, number]> = [a, b, centroid, b, c, centroid, c, a, centroid];
      output.forEach((point, index) => positions.set(point, triangle * 27 + index * 3));
    }
    const finer = new THREE.BufferGeometry();
    finer.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    current = finer;
  }
  return current;
}

/** Custom cuboid with interior subdivision and no primitive geometry metadata to lean on. */
export function subdividedBoxGeometry(width: number, height: number, depth: number, segments = 3): THREE.BufferGeometry {
  const faces: Array<{ origin: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 }> = [
    { origin: new THREE.Vector3(-width / 2, -height / 2, depth / 2), right: new THREE.Vector3(width / segments, 0, 0), up: new THREE.Vector3(0, height / segments, 0) },
    { origin: new THREE.Vector3(width / 2, -height / 2, -depth / 2), right: new THREE.Vector3(-width / segments, 0, 0), up: new THREE.Vector3(0, height / segments, 0) },
    { origin: new THREE.Vector3(-width / 2, -height / 2, -depth / 2), right: new THREE.Vector3(0, 0, depth / segments), up: new THREE.Vector3(0, height / segments, 0) },
    { origin: new THREE.Vector3(-width / 2, height / 2, depth / 2), right: new THREE.Vector3(0, 0, -depth / segments), up: new THREE.Vector3(0, -height / segments, 0) },
    { origin: new THREE.Vector3(-width / 2, height / 2, depth / 2), right: new THREE.Vector3(width / segments, 0, 0), up: new THREE.Vector3(0, 0, -depth / segments) },
    { origin: new THREE.Vector3(-width / 2, -height / 2, -depth / 2), right: new THREE.Vector3(width / segments, 0, 0), up: new THREE.Vector3(0, 0, depth / segments) },
  ];
  const positions: number[] = [];
  const point = (face: (typeof faces)[number], column: number, row: number): void => {
    const vertex = face.origin.clone().addScaledVector(face.right, column).addScaledVector(face.up, row);
    positions.push(vertex.x, vertex.y, vertex.z);
  };
  for (const face of faces) {
    for (let row = 0; row < segments; row += 1) {
      for (let column = 0; column < segments; column += 1) {
        point(face, column, row);
        point(face, column + 1, row);
        point(face, column + 1, row + 1);
        point(face, column, row);
        point(face, column + 1, row + 1);
        point(face, column, row + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function semanticMesh(id: string, geometry: THREE.BufferGeometry, position: [number, number, number], role?: string, critical = false): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x6b7358, roughness: 0.7 }));
  mesh.name = id;
  mesh.userData.semanticId = id;
  if (role) mesh.userData.semanticRole = role;
  mesh.userData.critical = critical;
  mesh.position.set(...position);
  return mesh;
}

/**
 * Physically meaningful low-poly tank: sloped glacis/rear loft hull, faceted octagonal turret
 * loft, gun, cupola, running gear, and paired track courses resting on the ground plane (min Y
 * = 0). `forward: "x"` authors the identical vehicle X-longitudinal so source-frame handling
 * can be exercised end to end.
 */
export function createSlopedTank(options: { wheelSegments?: number; detailMultiplier?: number; forward?: "z" | "x" } = {}): THREE.Group {
  const wheelSegments = options.wheelSegments ?? 12;
  const detail = options.detailMultiplier ?? 1;
  const root = new THREE.Group();
  root.name = "sloped-tank";
  root.userData.forwardAxis = "+z";

  const stations = [
    { z: -3.0, halfWidth: 1.15, bottom: 0.55, top: 1.05 },
    { z: -2.2, halfWidth: 1.45, bottom: 0.5, top: 1.45 },
    { z: -0.4, halfWidth: 1.55, bottom: 0.5, top: 1.6 },
    { z: 1.6, halfWidth: 1.5, bottom: 0.5, top: 1.5 },
    { z: 2.9, halfWidth: 1.25, bottom: 0.5, top: 1.05 },
  ];
  const hullGeometry = detail > 1 ? tessellateFiner(createLoftGeometry(stations), Math.round(Math.log2(detail))) : createLoftGeometry(stations);
  root.add(semanticMesh("hull", hullGeometry, [0, 0, 0]));

  const turretPivot = new THREE.Group();
  turretPivot.name = "turret-pivot";
  turretPivot.userData.semanticId = "turret-pivot";
  turretPivot.position.set(0, 1.62, -0.5);
  const turretStations = [
    { z: -1.15, halfWidth: 0.78, bottom: 0, top: 0.72 },
    { z: -0.4, halfWidth: 1.02, bottom: 0, top: 0.82 },
    { z: 0.55, halfWidth: 0.95, bottom: 0, top: 0.74 },
    { z: 1.05, halfWidth: 0.55, bottom: 0, top: 0.55 },
  ];
  const turretGeometry = detail > 1 ? tessellateFiner(createLoftGeometry(turretStations), Math.round(Math.log2(detail))) : createLoftGeometry(turretStations);
  turretPivot.add(semanticMesh("turret", turretGeometry, [0, 0, 0], undefined, true));

  const gunPivot = new THREE.Group();
  gunPivot.name = "gun-pivot";
  gunPivot.userData.semanticId = "gun-pivot";
  gunPivot.position.set(0, 0.42, 0.95);
  const gunLength = 3.2;
  const gun = semanticMesh("gun", new THREE.CylinderGeometry(0.11, 0.11, gunLength, 8), [0, 0, gunLength / 2], undefined, true);
  gun.rotation.x = Math.PI / 2;
  gunPivot.add(gun);
  turretPivot.add(gunPivot);

  turretPivot.add(semanticMesh("cupola", new THREE.CylinderGeometry(0.3, 0.34, 0.28, 8), [0.32, 0.85, -0.35], undefined, true));
  root.add(turretPivot);

  for (const side of [-1, 1]) {
    for (let index = 0; index < 5; index += 1) {
      const wheel = semanticMesh(`road-wheel-${side}-${index}`, new THREE.CylinderGeometry(0.5, 0.5, 0.24, wheelSegments), [side * 1.3, 0.5, -2.1 + index * 1.05], "road-wheel");
      wheel.rotation.z = Math.PI / 2;
      root.add(wheel);
    }
    // Tracks ride fully outboard of the hull AABB (max station half-width 1.55 + clearance)
    // so neither the source nor the derived course intrudes into the hull envelope.
    const track = semanticMesh(`track-${side}`, createTrackCourseGeometry(5.6, 1.15, 0.24, 0.32), [side * 1.82, 0.58, 0], "track-course");
    root.add(track);
  }

  if (options.forward === "x") {
    // Author the identical vehicle X-longitudinal by baking a rotation into world data.
    const rotated = new THREE.Group();
    rotated.name = "rotated-source";
    rotated.rotation.y = Math.PI / 2;
    rotated.updateMatrixWorld(true);
    for (const child of [...root.children]) rotated.add(child);
    return rotated;
  }
  return root;
}

/**
 * Builds a stable `node:N -> semanticId` map matching sceneToGlb()'s node ordering, so prepared
 * recipes can key semantics without relying on ambiguous source names.
 */
export function stableSemanticIdentityMap(root: THREE.Object3D, options: { includeRoot?: boolean } = {}): Record<string, string> {
  const map: Record<string, string> = {};
  let index = 0;
  const visit = (object: THREE.Object3D): void => {
    if (object.name) map[`node:${index}`] = object.name;
    index += 1;
    for (const child of object.children) visit(child);
  };
  if (options.includeRoot || !root.children.length) visit(root);
  else root.children.forEach(visit);
  return map;
}

interface GlbPbr {
  baseColorFactor: [number, number, number, number];
  roughnessFactor: number;
  metallicFactor: number;
}

interface GlbMesh {
  positions: Float32Array;
  pbr?: GlbPbr;
}

interface GlbNode {
  name: string;
  children: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  mesh?: number;
}

/**
 * Serializes a scene graph into a minimal but valid GLB: every Object3D becomes a node with its
 * local transform preserved, meshes keep their local (untransformed) positions, and unique node
 * names are enforced so semantic maps can key on names. With `includeRoot`, the given root
 * itself becomes a node so a deliberate top-level transform (e.g. an authored rotation) is part
 * of the source data.
 */
export function sceneToGlb(root: THREE.Object3D, options: { includeRoot?: boolean } = {}): Buffer {
  const dedupeNames = new Map<string, string>();
  const nodes: GlbNode[] = [];
  const meshes: GlbMesh[] = [];
  let counter = 0;
  const visit = (object: THREE.Object3D, nameForNode: string): number => {
    let name = nameForNode || object.name || `node-${counter}`;
    while (dedupeNames.has(name)) name = `${name}-${++counter}`;
    dedupeNames.set(name, name);
    const node: GlbNode = { name, children: [] };
    node.translation = [object.position.x, object.position.y, object.position.z];
    if (object.quaternion.x || object.quaternion.y || object.quaternion.z || object.quaternion.w !== 1) {
      node.rotation = [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w];
    }
    if (object.scale.x !== 1 || object.scale.y !== 1 || object.scale.z !== 1) {
      node.scale = [object.scale.x, object.scale.y, object.scale.z];
    }
    const mesh = object as THREE.Mesh;
    if ((mesh as unknown as { isMesh?: boolean }).isMesh && mesh.geometry?.getAttribute("position")) {
      const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
      const attribute = geometry.getAttribute("position");
      // Preserve simple PBR so oracle palette/style gates measure the authored material.
      // THREE.Color components are already LINEAR working-space values, matching the
      // glTF baseColorFactor definition; never serialize normalized sRGB bytes here.
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const standard = material && (material as THREE.MeshStandardMaterial).isMeshStandardMaterial ? material as THREE.MeshStandardMaterial : undefined;
      meshes.push({
        positions: new Float32Array(attribute.array as ArrayLike<number>),
        ...(standard ? {
          pbr: {
            baseColorFactor: [standard.color.r, standard.color.g, standard.color.b, standard.opacity],
            roughnessFactor: standard.roughness,
            metallicFactor: standard.metalness,
          },
        } : {}),
      });
      node.mesh = meshes.length - 1;
    }
    const index = nodes.push(node) - 1;
    for (const child of object.children) node.children.push(visit(child, ""));
    return index;
  };
  const sceneRoots = options.includeRoot || !root.children.length
    ? [visit(root, root.name || "root")]
    : [...root.children].map((child) => visit(child, child.name || "root"));
  const materials: Array<Record<string, unknown>> = [];
  const gltfMeshes = meshes.map((mesh, meshIndex) => {
    let materialIndex: number | undefined;
    if (mesh.pbr) {
      materialIndex = materials.length;
      materials.push({ pbrMetallicRoughness: mesh.pbr });
    }
    return {
      primitives: [{
        attributes: { POSITION: meshIndex },
        ...(materialIndex !== undefined ? { material: materialIndex } : {}),
      }],
    };
  });
  const bufferViews: Array<Record<string, unknown>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  const binChunks: Buffer[] = [];
  let offset = 0;
  meshes.forEach((mesh) => {
    const bytes = Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength);
    const padding = (4 - (offset % 4)) % 4;
    if (padding) { binChunks.push(Buffer.alloc(padding)); offset += padding; }
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < mesh.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis]!, mesh.positions[index + axis]!);
        max[axis] = Math.max(max[axis]!, mesh.positions[index + axis]!);
      }
    }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: mesh.positions.length / 3, type: "VEC3", min, max });
    binChunks.push(bytes);
    offset += bytes.length;
  });
  const bin = Buffer.concat(binChunks);
  const json: Record<string, unknown> = {
    asset: { version: "2.0", generator: "mesh2threejs-test-scene" },
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
    meshes: gltfMeshes,
    ...(materials.length ? { materials } : {}),
    nodes,
    scenes: [{ nodes: sceneRoots }],
    scene: 0,
  };
  let jsonBytes = Buffer.from(JSON.stringify(json));
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binBytes = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const output = Buffer.alloc(total);
  output.write("glTF", 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(total, 8);
  output.writeUInt32LE(jsonBytes.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(output, 20);
  const binHeader = 20 + jsonBytes.length;
  output.writeUInt32LE(binBytes.length, binHeader);
  output.writeUInt32LE(0x004e4942, binHeader + 4);
  binBytes.copy(output, binHeader + 8);
  return output;
}

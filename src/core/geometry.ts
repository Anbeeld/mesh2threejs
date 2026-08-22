import * as THREE from "three";
import type { Bounds3, Point3, SceneComponent, SceneSnapshot, SceneTriangle } from "../types.js";

const emptyBounds = (): Bounds3 => ({
  min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
  max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  size: [0, 0, 0],
  center: [0, 0, 0],
});

function finishBounds(bounds: Bounds3): Bounds3 {
  if (!bounds.min.every(Number.isFinite) || !bounds.max.every(Number.isFinite)) {
    return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  }
  const size: Point3 = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  return {
    min: [...bounds.min],
    max: [...bounds.max],
    size,
    center: [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ],
  };
}

function includePoint(bounds: Bounds3, point: Point3): void {
  for (let axis = 0; axis < 3; axis += 1) {
    const value = point[axis];
    if (value === undefined) continue;
    bounds.min[axis] = Math.min(bounds.min[axis] ?? value, value);
    bounds.max[axis] = Math.max(bounds.max[axis] ?? value, value);
  }
}

function semanticOwner(object: THREE.Object3D): { id: string; parent?: string; role?: string; critical: boolean } {
  let current: THREE.Object3D | null = object;
  let id: string | undefined;
  let role: string | undefined;
  let critical = false;
  while (current) {
    if (!id && typeof current.userData.semanticId === "string") {
      id = current.userData.semanticId;
      if (typeof current.userData.semanticRole === "string") role = current.userData.semanticRole;
      critical = current.userData.critical === true;
      let parent = current.parent;
      while (parent) {
        if (typeof parent.userData.semanticId === "string") {
          return { id, parent: parent.userData.semanticId, ...(role ? { role } : {}), critical };
        }
        parent = parent.parent;
      }
      return { id, ...(role ? { role } : {}), critical };
    }
    current = current.parent;
  }
  return { id: object.name || object.uuid, critical };
}

function materialRecord(
  mesh: THREE.Mesh,
  triangleIndex: number,
  materialId: (material: THREE.Material | undefined) => string,
): { id: string; color: number; roughness: number } {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let materialIndex = 0;
  const indexOffset = triangleIndex * 3;
  for (let groupIndex = 0; groupIndex < mesh.geometry.groups.length; groupIndex += 1) {
    const group = mesh.geometry.groups[groupIndex];
    if (group && indexOffset >= group.start && indexOffset < group.start + group.count) {
      materialIndex = group.materialIndex ?? 0;
      break;
    }
  }
  const material = materials[materialIndex] ?? materials[0];
  const standard = material as THREE.MeshStandardMaterial | undefined;
  return {
    id: materialId(material),
    color: standard?.color?.getHex() ?? 0x7f7f7f,
    roughness: typeof standard?.roughness === "number" ? standard.roughness : 0.7,
  };
}

function pointFromAttribute(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number, matrix: THREE.Matrix4): Point3 {
  const vector = new THREE.Vector3(attribute.getX(index), attribute.getY(index), attribute.getZ(index));
  vector.applyMatrix4(matrix);
  return [vector.x, vector.y, vector.z];
}

function faceNormal(points: [Point3, Point3, Point3]): Point3 {
  const a = new THREE.Vector3(...points[0]);
  const b = new THREE.Vector3(...points[1]);
  const c = new THREE.Vector3(...points[2]);
  const normal = b.sub(a).cross(c.sub(a)).normalize();
  return [normal.x, normal.y, normal.z];
}

export function snapshotScene(root: THREE.Object3D): SceneSnapshot {
  root.updateMatrixWorld(true);
  const triangles: SceneTriangle[] = [];
  const componentDrafts = new Map<string, Omit<SceneComponent, "bounds"> & { bounds: Bounds3 }>();
  const materialIds = new Set<string>();
  const materialIdentity = new WeakMap<THREE.Material, string>();
  let nextMaterialId = 0;
  const stableMaterialId = (material: THREE.Material | undefined): string => {
    if (!material) return "material-missing";
    const existing = materialIdentity.get(material);
    if (existing) return existing;
    const id = `material-${nextMaterialId}`;
    nextMaterialId += 1;
    materialIdentity.set(material, id);
    return id;
  };
  let meshCount = 0;
  const semanticOwners = new Map<string, THREE.Object3D>();

  root.traverse((object) => {
    const semanticId = typeof object.userData.semanticId === "string" ? object.userData.semanticId : undefined;
    if (!semanticId) return;
    const previous = semanticOwners.get(semanticId);
    if (previous && previous !== object) throw new Error(`ambiguous duplicate semantic id: ${semanticId}`);
    semanticOwners.set(semanticId, object);
  });

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
    const position = mesh.geometry.getAttribute("position");
    if (!position) return;
    meshCount += 1;
    const owner = semanticOwner(mesh);
    let component = componentDrafts.get(owner.id);
    if (!component) {
      component = {
        id: owner.id,
        name: mesh.name || owner.id,
        ...(owner.role ? { role: owner.role } : {}),
        ...(owner.parent ? { parentSemanticId: owner.parent } : {}),
        critical: owner.critical,
        triangleIndices: [],
        bounds: emptyBounds(),
      };
      componentDrafts.set(owner.id, component);
    }
    const index = mesh.geometry.index;
    const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
      const indices = index
        ? [index.getX(triangleIndex * 3), index.getX(triangleIndex * 3 + 1), index.getX(triangleIndex * 3 + 2)]
        : [triangleIndex * 3, triangleIndex * 3 + 1, triangleIndex * 3 + 2];
      const a = indices[0];
      const b = indices[1];
      const c = indices[2];
      if (a === undefined || b === undefined || c === undefined) continue;
      const points: [Point3, Point3, Point3] = [
        pointFromAttribute(position, a, mesh.matrixWorld),
        pointFromAttribute(position, b, mesh.matrixWorld),
        pointFromAttribute(position, c, mesh.matrixWorld),
      ];
      const material = materialRecord(mesh, triangleIndex, stableMaterialId);
      materialIds.add(material.id);
      const record: SceneTriangle = {
        points,
        normal: faceNormal(points),
        componentId: owner.id,
        materialId: material.id,
        color: material.color,
        roughness: material.roughness,
      };
      component.triangleIndices.push(triangles.length);
      points.forEach((point) => includePoint(component!.bounds, point));
      triangles.push(record);
    }
  });

  const components: Record<string, SceneComponent> = {};
  for (const [id, component] of componentDrafts) {
    components[id] = { ...component, bounds: finishBounds(component.bounds) };
  }
  for (const [id, object] of semanticOwners) {
    const worldOrigin = object.getWorldPosition(new THREE.Vector3());
    const origin: Point3 = [worldOrigin.x, worldOrigin.y, worldOrigin.z];
    if (components[id]) { components[id]!.origin = origin; continue; }
    const box = new THREE.Box3().setFromObject(object);
    const min: Point3 = [box.min.x, box.min.y, box.min.z];
    const max: Point3 = [box.max.x, box.max.y, box.max.z];
    const parent = object.parent && typeof object.parent.userData.semanticId === "string" ? object.parent.userData.semanticId : undefined;
    components[id] = {
      id,
      name: object.name || id,
      ...(typeof object.userData.semanticRole === "string" ? { role: object.userData.semanticRole } : {}),
      ...(parent ? { parentSemanticId: parent } : {}),
      critical: object.userData.critical === true,
      triangleIndices: [],
      bounds: finishBounds({ min, max, size: [0, 0, 0], center: [0, 0, 0] }),
      origin,
    };
  }
  const forwardAxis = typeof root.userData.forwardAxis === "string" ? root.userData.forwardAxis : undefined;
  return {
    triangles,
    components,
    meshCount,
    materialCount: materialIds.size,
    triangleCount: triangles.length,
    metadata: { name: root.name, ...(forwardAxis ? { forwardAxis } : {}) },
  };
}

export function boundsFromPoints(points: Iterable<Point3>): Bounds3 {
  const bounds = emptyBounds();
  for (const point of points) includePoint(bounds, point);
  return finishBounds(bounds);
}

export function componentPoints(snapshot: SceneSnapshot, filter?: (component: SceneComponent) => boolean): Point3[] {
  const accepted = new Set(
    Object.values(snapshot.components)
      .filter((component) => !filter || filter(component))
      .map((component) => component.id),
  );
  return snapshot.triangles
    .filter((triangle) => accepted.has(triangle.componentId))
    .flatMap((triangle) => triangle.points);
}

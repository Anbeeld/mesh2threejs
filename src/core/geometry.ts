import * as THREE from "three";
import type { Bounds3, Point3, SceneComponent, SceneSnapshot, SceneTriangle } from "../types.js";

/**
 * Inline non-subject check. Walks the ancestor chain to determine if a mesh
 * is marked as non-subject or presentation-fixture. Inlined here to avoid a circular import
 * with assembly.ts. The canonical classifier is `oracleGeometryDisposition` in assembly.ts;
 * this mirrors its non-subject detection for the snapshot hot path.
 */
function isNonSubjectMesh(mesh: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = mesh;
  while (current) {
    if (current.userData.insignificant === true) {
      const kind = current.userData.exclusionKind as string | undefined;
      if (kind === "non-subject" || kind === "presentation-fixture" || kind === undefined) return true;
    }
    current = current.parent;
  }
  return false;
}

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
      // Semantic ownership resolution order: the semantic object's own explicit logical owner
      // (prepared overlay) wins, then the actual semantic ancestor in the authored hierarchy.
      // A flat source hierarchy with a prepared ownership overlay therefore measures as
      // logically nested without physically reparenting any mesh.
      if (typeof current.userData.logicalOwner === "string" && current.userData.logicalOwner !== id) {
        return { id, parent: current.userData.logicalOwner, ...(role ? { role } : {}), critical };
      }
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
): { id: string; color: number; roughness: number; simplePbr: boolean; generatedOrNoTexture: boolean; flatShaded: boolean } {
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
  const map = standard?.map;
  return {
    id: materialId(material),
    color: standard?.color?.getHex() ?? 0x7f7f7f,
    roughness: typeof standard?.roughness === "number" ? standard.roughness : 0.7,
    simplePbr: Boolean(material && ((material as THREE.MeshStandardMaterial).isMeshStandardMaterial || (material as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial)),
    generatedOrNoTexture: !map || map.userData.generated === true || typeof map.userData.sourceHash === "string",
    flatShaded: standard?.flatShading === true,
  };
}

function geometrySegments(geometry: THREE.BufferGeometry): number[] {
  const parameters = (geometry as THREE.BufferGeometry & { parameters?: Record<string, unknown> & { options?: Record<string, unknown> } }).parameters;
  if (!parameters) return [];
  return [parameters.radialSegments, parameters.tubularSegments, parameters.widthSegments, parameters.options?.curveSegments]
    .filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 3);
}

function intrinsicallyFaceted(geometry: THREE.BufferGeometry): boolean {
  if (/(?:Box|Plane|Polyhedron|Edges|Shape)/u.test(geometry.type)) return true;
  if (geometry.type !== "ExtrudeGeometry") return false;
  const parameters = (geometry as THREE.BufferGeometry & { parameters?: { shapes?: THREE.Shape | THREE.Shape[]; options?: { bevelEnabled?: boolean } } }).parameters;
  if (!parameters?.shapes || parameters.options?.bevelEnabled !== false) return false;
  const shapes = Array.isArray(parameters.shapes) ? parameters.shapes : [parameters.shapes];
  const curves = shapes.flatMap((shape) => [shape, ...shape.holes].flatMap((path) => path.curves));
  return curves.length > 0 && curves.every((curve) => curve.type === "LineCurve");
}

function writeTransformedPoint(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number, matrix: THREE.Matrix4, target: Float64Array, offset: number, bounds: Bounds3): void {
  const x = attribute.getX(index); const y = attribute.getY(index); const z = attribute.getZ(index);
  const e = matrix.elements;
  const w = 1 / ((e[3]! * x) + (e[7]! * y) + (e[11]! * z) + e[15]! || 1);
  const tx = ((e[0]! * x) + (e[4]! * y) + (e[8]! * z) + e[12]!) * w;
  const ty = ((e[1]! * x) + (e[5]! * y) + (e[9]! * z) + e[13]!) * w;
  const tz = ((e[2]! * x) + (e[6]! * y) + (e[10]! * z) + e[14]!) * w;
  target[offset] = tx; target[offset + 1] = ty; target[offset + 2] = tz;
  bounds.min[0] = Math.min(bounds.min[0], tx); bounds.min[1] = Math.min(bounds.min[1], ty); bounds.min[2] = Math.min(bounds.min[2], tz);
  bounds.max[0] = Math.max(bounds.max[0], tx); bounds.max[1] = Math.max(bounds.max[1], ty); bounds.max[2] = Math.max(bounds.max[2], tz);
}

function writeFaceNormal(positions: Float64Array, positionOffset: number, normals: Float32Array, normalOffset: number): void {
  const abx = positions[positionOffset + 3]! - positions[positionOffset]!;
  const aby = positions[positionOffset + 4]! - positions[positionOffset + 1]!;
  const abz = positions[positionOffset + 5]! - positions[positionOffset + 2]!;
  const acx = positions[positionOffset + 6]! - positions[positionOffset]!;
  const acy = positions[positionOffset + 7]! - positions[positionOffset + 1]!;
  const acz = positions[positionOffset + 8]! - positions[positionOffset + 2]!;
  const nx = aby * acz - abz * acy; const ny = abz * acx - abx * acz; const nz = abx * acy - aby * acx;
  const length = Math.hypot(nx, ny, nz) || 1;
  normals[normalOffset] = nx / length; normals[normalOffset + 1] = ny / length; normals[normalOffset + 2] = nz / length;
}

export function snapshotScene(root: THREE.Object3D): SceneSnapshot {
  root.updateMatrixWorld(true);
  const semanticOwners = new Map<string, THREE.Object3D>();
  root.traverse((object) => {
    const semanticId = typeof object.userData.semanticId === "string" ? object.userData.semanticId : undefined;
    if (!semanticId) return;
    // Non-subject geometry must not appear as a component stub either.
    if (isNonSubjectMesh(object)) return;
    const previous = semanticOwners.get(semanticId);
    if (previous && previous !== object) throw new Error(`ambiguous duplicate semantic id: ${semanticId}`);
    semanticOwners.set(semanticId, object);
  });

  type MeshEntry = { mesh: THREE.Mesh; position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute; index: THREE.BufferAttribute | null; triangleCount: number; owner: ReturnType<typeof semanticOwner> };
  const entries: MeshEntry[] = [];
  const componentCounts = new Map<string, number>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
    if (isNonSubjectMesh(mesh)) return; // filter non-subject from fidelity snapshot
    const position = mesh.geometry.getAttribute("position");
    if (!position) return;
    const index = mesh.geometry.index;
    const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3);
    const owner = semanticOwner(mesh);
    entries.push({ mesh, position, index, triangleCount, owner });
    componentCounts.set(owner.id, (componentCounts.get(owner.id) ?? 0) + triangleCount);
  });

  const componentIds = [...componentCounts.keys()];
  const componentIndexById = new Map(componentIds.map((id, index) => [id, index]));
  const triangleCount = entries.reduce((sum, entry) => sum + entry.triangleCount, 0);
  const positions = new Float64Array(triangleCount * 9);
  const normals = new Float32Array(triangleCount * 3);
  const componentIndices = new Uint32Array(triangleCount);
  const materialIndices = new Uint32Array(triangleCount);
  const colors = new Uint32Array(triangleCount);
  const roughness = new Float32Array(triangleCount);
  const materialIdentity = new WeakMap<THREE.Material, string>();
  const materialIds: string[] = [];
  const materialIndexById = new Map<string, number>();
  const stableMaterialId = (material: THREE.Material | undefined): string => {
    if (!material) return "material-missing";
    const existing = materialIdentity.get(material);
    if (existing) return existing;
    const id = `material-${materialIds.length}`;
    materialIdentity.set(material, id);
    return id;
  };
  type ComponentDraft = Omit<SceneComponent, "bounds" | "triangleIndices"> & { bounds: Bounds3; triangleIndices: Uint32Array; cursor: number };
  const componentDrafts = new Map<string, ComponentDraft>();
  for (const entry of entries) {
    if (componentDrafts.has(entry.owner.id)) continue;
    componentDrafts.set(entry.owner.id, {
      id: entry.owner.id,
      name: entry.mesh.name || entry.owner.id,
      ...(entry.owner.role ? { role: entry.owner.role } : {}),
      ...(entry.owner.parent ? { parentSemanticId: entry.owner.parent } : {}),
      critical: entry.owner.critical,
      triangleIndices: new Uint32Array(componentCounts.get(entry.owner.id) ?? 0),
      cursor: 0,
      bounds: emptyBounds(),
      representation: { segmentCounts: [], flatOrFaceted: true, simplePbr: true, generatedOrNoTextures: true, colors: [] },
    });
  }
  let outputTriangle = 0;
  for (const entry of entries) {
    const component = componentDrafts.get(entry.owner.id)!;
    const segments = geometrySegments(entry.mesh.geometry);
    const uniformMaterial = entry.mesh.geometry.groups.length === 0 && !Array.isArray(entry.mesh.material) ? materialRecord(entry.mesh, 0, stableMaterialId) : undefined;
    component.representation.segmentCounts.push(...segments.filter((value) => !component.representation.segmentCounts.includes(value)));
    for (let triangleIndex = 0; triangleIndex < entry.triangleCount; triangleIndex += 1) {
      const indices = entry.index
        ? [entry.index.getX(triangleIndex * 3), entry.index.getX(triangleIndex * 3 + 1), entry.index.getX(triangleIndex * 3 + 2)]
        : [triangleIndex * 3, triangleIndex * 3 + 1, triangleIndex * 3 + 2];
      const positionOffset = outputTriangle * 9;
      writeTransformedPoint(entry.position, indices[0]!, entry.mesh.matrixWorld, positions, positionOffset, component.bounds);
      writeTransformedPoint(entry.position, indices[1]!, entry.mesh.matrixWorld, positions, positionOffset + 3, component.bounds);
      writeTransformedPoint(entry.position, indices[2]!, entry.mesh.matrixWorld, positions, positionOffset + 6, component.bounds);
      writeFaceNormal(positions, positionOffset, normals, outputTriangle * 3);
      const material = uniformMaterial ?? materialRecord(entry.mesh, triangleIndex, stableMaterialId);
      let materialIndex = materialIndexById.get(material.id);
      if (materialIndex === undefined) { materialIndex = materialIds.length; materialIndexById.set(material.id, materialIndex); materialIds.push(material.id); }
      component.representation.flatOrFaceted &&= material.flatShaded || intrinsicallyFaceted(entry.mesh.geometry) || segments.length > 0;
      component.representation.simplePbr &&= material.simplePbr;
      component.representation.generatedOrNoTextures &&= material.generatedOrNoTexture;
      if (!component.representation.colors.includes(material.color)) component.representation.colors.push(material.color);
      componentIndices[outputTriangle] = componentIndexById.get(entry.owner.id)!;
      materialIndices[outputTriangle] = materialIndex;
      colors[outputTriangle] = material.color;
      roughness[outputTriangle] = material.roughness;
      component.triangleIndices[component.cursor++] = outputTriangle;
      outputTriangle += 1;
    }
  }

  const components: Record<string, SceneComponent> = {};
  for (const [id, { cursor: _cursor, ...component }] of componentDrafts) components[id] = { ...component, bounds: finishBounds(component.bounds) };
  for (const [id, object] of semanticOwners) {
    const worldOrigin = object.getWorldPosition(new THREE.Vector3());
    const origin: Point3 = [worldOrigin.x, worldOrigin.y, worldOrigin.z];
    if (components[id]) { components[id]!.origin = origin; continue; }
    const box = new THREE.Box3().setFromObject(object);
    const min: Point3 = [box.min.x, box.min.y, box.min.z];
    const max: Point3 = [box.max.x, box.max.y, box.max.z];
    const logicalOwner = typeof object.userData.logicalOwner === "string" && object.userData.logicalOwner !== id ? object.userData.logicalOwner : undefined;
    const parent = logicalOwner ?? (object.parent && typeof object.parent.userData.semanticId === "string" ? object.parent.userData.semanticId : undefined);
    components[id] = {
      id,
      name: object.name || id,
      ...(typeof object.userData.semanticRole === "string" ? { role: object.userData.semanticRole } : {}),
      ...(parent ? { parentSemanticId: parent } : {}),
      critical: object.userData.critical === true,
      triangleIndices: new Uint32Array(0),
      bounds: finishBounds({ min, max, size: [0, 0, 0], center: [0, 0, 0] }),
      origin,
      representation: { segmentCounts: [], flatOrFaceted: true, simplePbr: true, generatedOrNoTextures: true, colors: [] },
    };
  }
  const forwardAxis = typeof root.userData.forwardAxis === "string" ? root.userData.forwardAxis : undefined;
  return {
    triangleData: { positions, normals, componentIndices, materialIndices, colors, roughness, componentIds, materialIds },
    components,
    meshCount: entries.length,
    materialCount: materialIds.length,
    triangleCount,
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
  const points: Point3[] = [];
  forEachSceneTriangle(snapshot, (triangle) => { if (accepted.has(triangle.componentId)) points.push(...triangle.points); });
  return points;
}

export function sceneTriangleAt(snapshot: SceneSnapshot, index: number): SceneTriangle | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= snapshot.triangleCount) return undefined;
  index = snapshot.triangleSelection?.[index] ?? index;
  const point = (vertex: number): Point3 => {
    const offset = index * 9 + vertex * 3;
    return [snapshot.triangleData.positions[offset]!, snapshot.triangleData.positions[offset + 1]!, snapshot.triangleData.positions[offset + 2]!];
  };
  const normalOffset = index * 3;
  return {
    points: [point(0), point(1), point(2)],
    normal: [snapshot.triangleData.normals[normalOffset]!, snapshot.triangleData.normals[normalOffset + 1]!, snapshot.triangleData.normals[normalOffset + 2]!],
    componentId: snapshot.triangleData.componentIds[snapshot.triangleData.componentIndices[index]!]!,
    materialId: snapshot.triangleData.materialIds[snapshot.triangleData.materialIndices[index]!]!,
    color: snapshot.triangleData.colors[index]!,
    roughness: snapshot.triangleData.roughness[index]!,
  };
}

export function forEachSceneTriangle(snapshot: SceneSnapshot, visit: (triangle: SceneTriangle, index: number) => void): void {
  for (let index = 0; index < snapshot.triangleCount; index += 1) visit(sceneTriangleAt(snapshot, index)!, index);
}

/** Allocation-free traversal. The triangle and point arrays are reused and must not be retained by the visitor. */
export function forEachSceneTriangleReusable(snapshot: SceneSnapshot, visit: (triangle: SceneTriangle, index: number) => void): void {
  const triangle: SceneTriangle = { points: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], normal: [0, 0, 0], componentId: "", materialId: "", color: 0, roughness: 0 };
  for (let selectionIndex = 0; selectionIndex < snapshot.triangleCount; selectionIndex += 1) {
    const index = snapshot.triangleSelection?.[selectionIndex] ?? selectionIndex;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const offset = index * 9 + vertex * 3; const point = triangle.points[vertex]!;
      point[0] = snapshot.triangleData.positions[offset]!; point[1] = snapshot.triangleData.positions[offset + 1]!; point[2] = snapshot.triangleData.positions[offset + 2]!;
    }
    const normalOffset = index * 3;
    triangle.normal[0] = snapshot.triangleData.normals[normalOffset]!; triangle.normal[1] = snapshot.triangleData.normals[normalOffset + 1]!; triangle.normal[2] = snapshot.triangleData.normals[normalOffset + 2]!;
    triangle.componentId = snapshot.triangleData.componentIds[snapshot.triangleData.componentIndices[index]!]!;
    triangle.materialId = snapshot.triangleData.materialIds[snapshot.triangleData.materialIndices[index]!]!;
    triangle.color = snapshot.triangleData.colors[index]!; triangle.roughness = snapshot.triangleData.roughness[index]!;
    visit(triangle, selectionIndex);
  }
}

export function selectSnapshotComponents(snapshot: SceneSnapshot, filter: (component: SceneComponent) => boolean): SceneSnapshot {
  const components = Object.fromEntries(Object.entries(snapshot.components).filter(([, component]) => filter(component)));
  const oldIndices = Object.values(components).flatMap((component) => Array.from(component.triangleIndices));
  const remapped = Object.fromEntries(Object.entries(components).map(([id, component]) => [id, { ...component, triangleIndices: new Uint32Array(component.triangleIndices.length) }])) as Record<string, SceneComponent>;
  const cursors = new Map<string, number>();
  oldIndices.forEach((oldIndex, newIndex) => {
    const triangle = sceneTriangleAt(snapshot, oldIndex)!;
    const cursor = cursors.get(triangle.componentId) ?? 0;
    remapped[triangle.componentId]!.triangleIndices[cursor] = newIndex;
    cursors.set(triangle.componentId, cursor + 1);
  });
  return { ...snapshot, components: remapped, triangleSelection: Uint32Array.from(oldIndices.map((index) => snapshot.triangleSelection?.[index] ?? index)), triangleCount: oldIndices.length, meshCount: Object.keys(components).length };
}

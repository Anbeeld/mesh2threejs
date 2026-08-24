import * as THREE from "three";
import { canonicalJson, sha256 } from "./hashing.js";

/**
 * Trusted scene serialization. The CandidateExecutor produces this artifact for the exact
 * evaluated candidate; authoritative consumers (gates, renders, viewer) reconstruct the
 * scene from it instead of touching untrusted runtime objects or candidate source.
 */

interface SerializedMaterial {
  /** Preserves PBR class: evaluator style gates distinguish standard vs basic materials. */
  kind: "standard" | "basic";
  color: number;
  roughness: number;
  metalness: number;
  vertexColors: boolean;
  flatShading: boolean;
}

interface SerializedGeometry {
  /** Original three geometry type (Box/Plane/...) so evaluator representation checks survive. */
  geometryType: string;
  index: number[] | null;
  attributes: { position: number[]; normal: number[] | null };
  groups: Array<{ start: number; count: number; materialIndex: number }>;
  /** Constructor segment parameters the snapshot pipeline reads for facet evidence. */
  parameters?: Record<string, unknown>;
}

export interface SerializedNode {
  name: string;
  type: "group" | "mesh" | "object";
  semanticId?: string;
  semanticRole?: string;
  articulationPivot?: string;
  logicalOwner?: string;
  visible: boolean;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  geometry?: SerializedGeometry;
  materials?: SerializedMaterial[];
  children: SerializedNode[];
}

export interface SerializedScene {
  schemaVersion: 1;
  root: SerializedNode;
}

function serializeVector(vector: THREE.Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

function serializeMaterial(material: THREE.Material): SerializedMaterial {
  const standard = material as THREE.MeshStandardMaterial;
  return {
    kind: Boolean((material as THREE.MeshStandardMaterial).isMeshStandardMaterial || (material as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) ? "standard" : "basic",
    color: standard.color ? standard.color.getHex() : 0xffffff,
    roughness: typeof standard.roughness === "number" ? standard.roughness : 1,
    metalness: typeof standard.metalness === "number" ? standard.metalness : 0,
    vertexColors: Boolean(standard.vertexColors),
    flatShading: Boolean(standard.flatShading),
  };
}

function serializeGeometry(geometry: THREE.BufferGeometry): SerializedGeometry {
  const position = geometry.getAttribute("position");
  if (!position) throw new Error("serialized mesh geometry lacks positions");
  const normal = geometry.getAttribute("normal");
  const index = geometry.index;
  const parameters = (geometry as THREE.BufferGeometry & { parameters?: Record<string, unknown> }).parameters;
  const serializedParameters = parameters
    ? (Object.fromEntries(Object.entries(parameters).filter(([, value]) => typeof value === "number" || (value && typeof value === "object" && "curveSegments" in (value as Record<string, unknown>)))) as Record<string, unknown>)
    : undefined;
  return {
    geometryType: geometry.type,
    index: index ? Array.from(index.array) : null,
    attributes: {
      position: Array.from(position.array as Float32Array),
      normal: normal ? Array.from(normal.array as Float32Array) : null,
    },
    groups: geometry.groups.map((group) => ({ start: group.start, count: group.count, materialIndex: group.materialIndex ?? 0 })),
    ...(serializedParameters && Object.keys(serializedParameters).length ? { parameters: serializedParameters } : {}),
  };
}

function serializeNode(node: THREE.Object3D): SerializedNode {
  const serialized: SerializedNode = {
    name: node.name,
    type: node instanceof THREE.Mesh ? "mesh" : node instanceof THREE.Group ? "group" : "object",
    visible: node.visible,
    position: serializeVector(node.position),
    quaternion: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
    scale: serializeVector(node.scale),
    children: node.children.map(serializeNode),
  };
  const semantic = node.userData as { semanticId?: unknown; semanticRole?: unknown; articulationPivot?: unknown; logicalOwner?: unknown };
  if (typeof semantic.semanticId === "string") serialized.semanticId = semantic.semanticId;
  if (typeof semantic.semanticRole === "string") serialized.semanticRole = semantic.semanticRole;
  if (typeof semantic.articulationPivot === "string") serialized.articulationPivot = semantic.articulationPivot;
  if (typeof semantic.logicalOwner === "string") serialized.logicalOwner = semantic.logicalOwner;
  if (node instanceof THREE.Mesh) {
    serialized.geometry = serializeGeometry(node.geometry);
    const materials = Array.isArray(node.material) ? node.material.map(serializeMaterial) : [serializeMaterial(node.material)];
    serialized.materials = materials;
  }
  return serialized;
}

export function serializeScene(root: THREE.Object3D): SerializedScene {
  root.updateMatrixWorld(true);
  return { schemaVersion: 1, root: serializeNode(root) };
}

function applySemanticUserData(node: THREE.Object3D, serialized: SerializedNode): void {
  if (serialized.semanticId) node.userData.semanticId = serialized.semanticId;
  if (serialized.semanticRole) node.userData.semanticRole = serialized.semanticRole;
  if (serialized.articulationPivot) node.userData.articulationPivot = serialized.articulationPivot;
  if (serialized.logicalOwner) node.userData.logicalOwner = serialized.logicalOwner;
}

function deserializeNode(serialized: SerializedNode): THREE.Object3D {
  const node = serialized.type === "mesh"
    ? (() => {
        if (!serialized.geometry || !serialized.materials?.length) throw new Error(`serialized mesh ${serialized.name} lacks geometry/materials`);
        const geometry = new THREE.BufferGeometry();
        if (serialized.geometry.geometryType && serialized.geometry.geometryType !== "BufferGeometry") {
          Object.defineProperty(geometry, "type", { value: serialized.geometry.geometryType, configurable: true });
        }
        if (serialized.geometry.parameters) {
          (geometry as THREE.BufferGeometry & { parameters?: Record<string, unknown> }).parameters = serialized.geometry.parameters;
        }
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(serialized.geometry.attributes.position, 3));
        if (serialized.geometry.attributes.normal) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(serialized.geometry.attributes.normal, 3));
        else geometry.computeVertexNormals();
        if (serialized.geometry.index) geometry.setIndex(serialized.geometry.index);
        for (const group of serialized.geometry.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
        const materials = serialized.materials.map((material) => {
          if (material.kind === "basic") {
            const basic = new THREE.MeshBasicMaterial({ color: material.color, vertexColors: material.vertexColors });
            (basic as THREE.MeshBasicMaterial & { flatShading: boolean }).flatShading = material.flatShading;
            return basic;
          }
          const standard = new THREE.MeshStandardMaterial({
            color: material.color,
            roughness: material.roughness,
            metalness: material.metalness,
            vertexColors: material.vertexColors,
          });
          standard.flatShading = material.flatShading;
          return standard;
        });
        return new THREE.Mesh(geometry, materials.length === 1 ? materials[0]! : materials);
      })()
    : new THREE.Group();
  node.name = serialized.name;
  node.visible = serialized.visible;
  node.position.fromArray(serialized.position);
  node.quaternion.fromArray(serialized.quaternion);
  node.scale.fromArray(serialized.scale);
  applySemanticUserData(node, serialized);
  for (const child of serialized.children) node.add(deserializeNode(child));
  return node;
}

export function deserializeScene(serialized: SerializedScene): THREE.Object3D {
  if (serialized.schemaVersion !== 1) throw new Error("serialized scene schema is unsupported");
  return deserializeNode(serialized.root);
}

export function serializedSceneHash(serialized: SerializedScene): string {
  return sha256(canonicalJson(serialized));
}

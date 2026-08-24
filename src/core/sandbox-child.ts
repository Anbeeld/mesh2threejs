import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as THREE from "three";

/**
 * Trusted sandbox child runner (development of §8). Executes ONLY the staged candidate
 * graph with a sanitized environment and writes a serialized scene per requested pose.
 * It never touches workspace state, oracle bytes, reports, or evidence.
 */

interface ChildRequest {
  entry: string;
  poses: Array<Record<string, number>>;
}

interface CandidateModuleLike {
  createCandidate: () => Promise<unknown> | unknown;
}

function isRuntime(value: unknown): value is { root: THREE.Object3D; setPose?: (pose: Record<string, number>) => void | Promise<void> } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { root?: unknown };
  if (candidate.root && (candidate.root as THREE.Object3D).isObject3D === true) return true;
  return false;
}

function serialize(node: THREE.Object3D): unknown {
  node.updateMatrixWorld(true);
  const walk = (object: THREE.Object3D): unknown => {
    const base: Record<string, unknown> = {
      name: object.name,
      type: object instanceof THREE.Mesh ? "mesh" : object instanceof THREE.Group ? "group" : "object",
      visible: object.visible,
      position: [object.position.x, object.position.y, object.position.z],
      quaternion: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
      scale: [object.scale.x, object.scale.y, object.scale.z],
      children: object.children.map(walk),
    };
    const semantic = object.userData as Record<string, unknown>;
    for (const key of ["semanticId", "semanticRole", "articulationPivot", "logicalOwner"]) {
      if (typeof semantic[key] === "string") base[key] = semantic[key];
    }
    if (object instanceof THREE.Mesh) {
      const geometry = object.geometry as THREE.BufferGeometry;
      const position = geometry.getAttribute("position");
      const normal = geometry.getAttribute("normal");
      const index = geometry.index;
      const parameters = (geometry as THREE.BufferGeometry & { parameters?: Record<string, unknown> }).parameters;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      base.geometry = {
        geometryType: geometry.type,
        index: index ? Array.from(index.array) : null,
        attributes: {
          position: position ? Array.from(position.array as Float32Array) : [],
          normal: normal ? Array.from(normal.array as Float32Array) : null,
        },
        groups: geometry.groups.map((group) => ({ start: group.start, count: group.count, materialIndex: group.materialIndex ?? 0 })),
        ...(parameters ? { parameters } : {}),
      };
      base.materials = materials.map((material) => {
        const standard = material as THREE.MeshStandardMaterial;
        return {
          kind: Boolean(standard.isMeshStandardMaterial || (standard as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) ? "standard" : "basic",
          color: standard.color ? standard.color.getHex() : 0xffffff,
          roughness: typeof standard.roughness === "number" ? standard.roughness : 1,
          metalness: typeof standard.metalness === "number" ? standard.metalness : 0,
          vertexColors: Boolean(standard.vertexColors),
          flatShading: Boolean(standard.flatShading),
        };
      });
    }
    return base;
  };
  return { schemaVersion: 1, root: walk(node) };
}

async function main(): Promise<void> {
  const [, , requestPath, outputPath] = process.argv;
  if (!requestPath || !outputPath) throw new Error("sandbox child requires request and output paths");
  const request = JSON.parse(await readFile(requestPath, "utf8")) as ChildRequest;
  const imported = (await import(pathToFileURL(request.entry).href)) as CandidateModuleLike;
  if (!imported || typeof imported.createCandidate !== "function") throw new Error("candidate module must export createCandidate()");
  const built = await imported.createCandidate();
  let root: THREE.Object3D;
  let setPose: (pose: Record<string, number>) => void | Promise<void>;
  if (isRuntime(built) && typeof (built as { setPose?: unknown }).setPose === "function") {
    root = built.root;
    setPose = built.setPose!;
  } else if ((built as THREE.Object3D)?.isObject3D === true) {
    root = built as THREE.Object3D;
    setPose = () => { throw new Error("candidate does not expose physical articulation controls"); };
  } else {
    throw new Error("createCandidate() must return a THREE.Object3D or candidate runtime");
  }
  const samples = [];
  for (const pose of request.poses) {
    if (Object.values(pose).some((value) => Math.abs(value) > 1e-12)) await setPose(pose);
    samples.push({ pose, serialization: serialize(root) });
  }
  await writeFile(outputPath, JSON.stringify({ samples }));
}

main().catch(async (error: unknown) => {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : String(error));
  process.exit(1);
});

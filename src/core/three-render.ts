import * as THREE from "three";
import type { CaptureCamera, CaptureFrame, CapturePass, RenderProfile, SceneSnapshot } from "../types.js";
import { canonicalJson, sha256 } from "./hashing.js";
import { rasterizeCapture } from "./render.js";

export interface ThreeRenderSurface {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  context?: WebGL2RenderingContext;
}

export type RenderBackend = "auto" | "deterministic-cpu" | "three-webgl";

export function renderCapture(input: { root: THREE.Object3D; snapshot: SceneSnapshot; profile: RenderProfile; camera: CaptureCamera; pass: CapturePass; backend?: RenderBackend; surface?: ThreeRenderSurface }): { frame: CaptureFrame; backend: Exclude<RenderBackend, "auto"> } {
  const backend = input.backend ?? "auto";
  if (backend === "three-webgl" && !input.surface) throw new Error("three-webgl rendering requires a caller-provided browser or headless WebGL surface");
  if (input.surface && backend !== "deterministic-cpu") return { frame: renderWithThreeWebGL(input.root, input.profile, input.camera, input.pass, input.surface), backend: "three-webgl" };
  return { frame: rasterizeCapture(input.snapshot, input.profile, input.camera, input.pass), backend: "deterministic-cpu" };
}

function makeCamera(profile: RenderProfile, capture: CaptureCamera): THREE.Camera {
  const aspect = profile.renderer.width / profile.renderer.height;
  const camera = capture.projection === "orthographic"
    ? new THREE.OrthographicCamera(-profile.camera.orthographicHeight * aspect / 2, profile.camera.orthographicHeight * aspect / 2, profile.camera.orthographicHeight / 2, -profile.camera.orthographicHeight / 2, profile.camera.near, profile.camera.far)
    : new THREE.PerspectiveCamera(profile.camera.perspectiveFov, aspect, profile.camera.near, profile.camera.far);
  camera.position.set(...capture.position);
  camera.lookAt(...capture.target);
  camera.updateMatrixWorld(true);
  return camera;
}

function overrideMaterial(pass: CapturePass): THREE.Material | null {
  switch (pass) {
    case "alpha-silhouette": return new THREE.MeshBasicMaterial({ color: 0xffffff });
    case "depth": return new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    case "normal": return new THREE.MeshNormalMaterial();
    default: return null;
  }
}

function hashColor(value: string): number {
  return Number.parseInt(sha256(value).slice(0, 6), 16);
}

export function materialDiagnosticKey(material: THREE.Material | undefined): string {
  if (!material) return canonicalJson({ type: "missing" });
  const physical = material as THREE.MeshStandardMaterial;
  const map = physical.map;
  return canonicalJson({
    type: material.type,
    name: material.name,
    color: physical.color?.getHex(),
    emissive: physical.emissive?.getHex(),
    roughness: physical.roughness,
    metalness: physical.metalness,
    opacity: material.opacity,
    transparent: material.transparent,
    side: material.side,
    vertexColors: material.vertexColors,
    flatShading: physical.flatShading,
    map: map ? { name: map.name, sourceHash: typeof map.userData.sourceHash === "string" ? map.userData.sourceHash : undefined } : undefined,
  });
}

function applyDiagnosticMaterials(root: THREE.Object3D, pass: CapturePass): () => void {
  if (pass !== "semantic-id" && pass !== "roughness-material-id") return () => undefined;
  const originals: Array<{ mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }> = [];
  const diagnostics: THREE.Material[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    originals.push({ mesh, material: mesh.material });
    const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    let semanticObject: THREE.Object3D | null = mesh;
    while (semanticObject && typeof semanticObject.userData.semanticId !== "string") semanticObject = semanticObject.parent;
    const semantic = typeof semanticObject?.userData.semanticId === "string" ? semanticObject.userData.semanticId : mesh.name;
    if (pass === "semantic-id") mesh.material = new THREE.MeshBasicMaterial({ color: hashColor(semantic) });
    else {
      const roughness = (source as THREE.MeshStandardMaterial | undefined)?.roughness ?? 0.7;
      const materialId = materialDiagnosticKey(source);
      const digest = hashColor(materialId);
      mesh.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(roughness, ((digest >> 8) & 0xff) / 255, (digest & 0xff) / 255) });
    }
    diagnostics.push(mesh.material as THREE.Material);
  });
  return () => {
    for (const item of originals) item.mesh.material = item.material;
    for (const material of diagnostics) material.dispose();
  };
}

/** Render evidence through Three.js' real WebGLRenderer. The caller supplies a browser/headless WebGL surface. */
export function renderWithThreeWebGL(root: THREE.Object3D, profile: RenderProfile, cameraSpec: CaptureCamera, pass: CapturePass, surface: ThreeRenderSurface): CaptureFrame {
  const renderer = new THREE.WebGLRenderer({ canvas: surface.canvas as HTMLCanvasElement, ...(surface.context ? { context: surface.context } : {}), antialias: false, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(profile.renderer.width, profile.renderer.height, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = profile.renderer.exposure;
  renderer.setClearColor(pass === "alpha-silhouette" ? 0x000000 : new THREE.Color(profile.background[0] / 255, profile.background[1] / 255, profile.background[2] / 255), pass === "alpha-silhouette" ? 0 : profile.background[3] / 255);
  const scene = new THREE.Scene();
  const renderRoot = root.clone(true);
  scene.add(renderRoot);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x27303a, 0.65));
  const key = new THREE.DirectionalLight(0xffffff, profile.environment.intensity);
  key.position.set(4, 8, 6);
  scene.add(key);
  const passOverride = overrideMaterial(pass);
  scene.overrideMaterial = passOverride;
  const restoreMaterials = applyDiagnosticMaterials(renderRoot, pass);
  try {
    renderer.render(scene, makeCamera(profile, cameraSpec));
    const raw = new Uint8Array(profile.renderer.width * profile.renderer.height * 4);
    const context = renderer.getContext();
    context.readPixels(0, 0, profile.renderer.width, profile.renderer.height, context.RGBA, context.UNSIGNED_BYTE, raw);
    const data = new Uint8Array(raw.length);
    const rowBytes = profile.renderer.width * 4;
    for (let y = 0; y < profile.renderer.height; y += 1) data.set(raw.subarray((profile.renderer.height - 1 - y) * rowBytes, (profile.renderer.height - y) * rowBytes), y * rowBytes);
    return { pass, cameraId: cameraSpec.id, width: profile.renderer.width, height: profile.renderer.height, data, profileHash: sha256(canonicalJson({ ...profile, backend: "three-webgl", threeRevision: THREE.REVISION })) };
  } finally {
    scene.overrideMaterial = null;
    restoreMaterials();
    passOverride?.dispose();
    scene.remove(renderRoot);
    renderer.dispose();
  }
}

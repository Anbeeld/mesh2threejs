import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlay-title");
const overlayDetail = document.getElementById("overlay-detail");
const banner = document.getElementById("banner");
const statsPanel = document.getElementById("stats");
const viewsPanel = document.getElementById("views");
const posePanel = document.getElementById("pose");

function showOverlay(title, detail) {
  overlayTitle.textContent = title;
  overlayDetail.textContent = detail || "";
  overlay.style.display = "flex";
}

function hideOverlay() {
  overlay.style.display = "none";
}

function showBanner(text) {
  banner.textContent = text;
  banner.style.display = "block";
}

function hideBanner() {
  banner.style.display = "none";
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function main() {
  const model = await fetchJson("/api/model");
  if (model.status !== "ok") {
    showOverlay("Candidate is not ready", model.error || "The candidate audit is failing. Fix the candidate source; the viewer reloads automatically once it is valid again.");
    pollForRecovery(null);
    return;
  }

  let built;
  try {
    const module = await import(model.entry);
    if (typeof module.createCandidate !== "function") throw new Error("candidate module must export createCandidate()");
    built = await module.createCandidate();
  } catch (error) {
    showOverlay("Candidate failed to load", error instanceof Error ? error.stack || error.message : String(error));
    pollForRecovery(model.sourceHash);
    return;
  }
  const root = built && built.root && built.root.isObject3D ? built.root : built;
  const setPose = built && typeof built.setPose === "function" ? built.setPose.bind(built) : null;
  if (!root || !root.isObject3D) {
    showOverlay("Candidate failed to load", "createCandidate() must return a THREE.Object3D or a runtime with root/setPose.");
    pollForRecovery(model.sourceHash);
    return;
  }
  hideOverlay();
  startViewer(model, root, setPose);
}

function startViewer(model, root, setPose) {
  const container = document.getElementById("app");
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x24282d);
  scene.add(new THREE.HemisphereLight(0xf4f6f8, 0x2c2f34, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(4, 8, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdfe8f2, 0.5);
  fill.position.set(-6, 3, -4);
  scene.add(fill);
  scene.add(root);

  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 1e-6);

  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, span / 1000, span * 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;

  const fitDistance = (span * 1.6) / (2 * Math.tan((camera.fov * Math.PI) / 360));
  const directions = {
    "Isometric": [0.62, 0.42, 0.62],
    "Side (+x)": [1, 0, 0],
    "Front (+z)": [0, 0, 1],
    "Top (+y)": [0, 1, 0.001],
    "Rear (-z)": [0, 0, -1],
    "Opposite side (-x)": [-1, 0, 0],
  };
  const applyView = (name) => {
    const [dx, dy, dz] = directions[name];
    camera.position.set(center.x + dx * fitDistance * 2.2, center.y + dy * fitDistance * 2.2, center.z + dz * fitDistance * 2.2);
    camera.up.set(0, 1, 0);
    controls.target.copy(center);
    camera.lookAt(center);
    controls.update();
  };

  for (const name of Object.keys(directions)) {
    const button = document.createElement("button");
    button.textContent = name;
    button.addEventListener("click", () => applyView(name));
    viewsPanel.appendChild(button);
  }
  const reset = document.createElement("button");
  reset.textContent = "Reset view";
  reset.addEventListener("click", () => applyView("Isometric"));
  viewsPanel.appendChild(reset);
  applyView("Isometric");

  const stats = computeStats(root, model, size);
  renderStats(stats);

  if (model.articulation && model.articulation.length && setPose) {
    setupPoseControls(model.articulation, setPose);
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  pollForRecovery(model.sourceHash);
}

function computeStats(root, model, size) {
  let meshCount = 0;
  let triangleCount = 0;
  root.traverse((object) => {
    if (object.isMesh) {
      meshCount += 1;
      const geometry = object.geometry;
      triangleCount += Math.floor((geometry.index ? geometry.index.count : geometry.attributes.position?.count ?? 0) / 3);
    }
  });
  return {
    dimensions: size,
    meshCount,
    triangleCount,
    candidateHash: model.candidateHash || model.sourceHash || "unverified",
    sourceHash: model.sourceHash,
    activePhase: model.activePhase || "n/a",
  };
}

function renderStats(stats) {
  const rows = [
    ["dimensions", `${stats.dimensions.x.toFixed(3)} x ${stats.dimensions.y.toFixed(3)} x ${stats.dimensions.z.toFixed(3)}`],
    ["meshes", String(stats.meshCount)],
    ["triangles", String(stats.triangleCount)],
    ["candidate", `${String(stats.candidateHash).slice(0, 12)}…`],
    ["active phase", stats.activePhase],
  ];
  statsPanel.replaceChildren(...rows.map(([key, value]) => {
    const row = document.createElement("div");
    row.className = "row";
    const keyElement = document.createElement("span");
    keyElement.className = "key";
    keyElement.textContent = key;
    const valueElement = document.createElement("span");
    valueElement.className = "value";
    valueElement.textContent = value;
    row.append(keyElement, valueElement);
    return row;
  }));
}

function setupPoseControls(articulation, setPose) {
  posePanel.style.display = "block";
  const poseState = Object.fromEntries(articulation.map((control) => [control.control, control.neutral ?? 0]));
  const applyPose = () => setPose({ ...poseState });
  for (const control of articulation) {
    const wrapper = document.createElement("div");
    wrapper.className = "control";
    const label = document.createElement("label");
    const name = document.createElement("span");
    name.textContent = control.control;
    const value = document.createElement("span");
    value.textContent = String(poseState[control.control]);
    label.append(name, value);
    const slider = document.createElement("input");
    slider.type = "range";
    const span = Math.max(control.max - control.min, 1e-6);
    slider.min = String(control.min);
    slider.max = String(control.max);
    slider.step = String(span / 200);
    slider.value = String(poseState[control.control]);
    slider.addEventListener("input", () => {
      poseState[control.control] = Number(slider.value);
      value.textContent = Number(slider.value).toFixed(3);
      applyPose();
    });
    slider.dataset.control = control.control;
    wrapper.append(label, slider);
    posePanel.appendChild(wrapper);
  }
  const resetButton = document.createElement("button");
  resetButton.textContent = "Reset pose";
  resetButton.addEventListener("click", () => {
    for (const control of articulation) {
      poseState[control.control] = control.neutral ?? 0;
      const slider = posePanel.querySelector(`input[data-control="${control.control}"]`);
      if (slider) slider.value = String(poseState[control.control]);
    }
    for (const label of posePanel.querySelectorAll("label span:last-child")) label.textContent = "0";
    applyPose();
  });
  posePanel.appendChild(resetButton);
}

function pollForRecovery(loadedSourceHash) {
  setInterval(async () => {
    try {
      const version = await fetchJson("/api/version");
      if (version.status === "ok") {
        hideBanner();
        if (loadedSourceHash !== null && version.sourceHash !== loadedSourceHash) {
          window.location.reload();
        } else if (loadedSourceHash === null) {
          window.location.reload();
        }
      } else {
        showBanner("Candidate audit is failing; fix the source. The viewer reloads automatically once valid.");
      }
    } catch {
      /* server briefly unreachable; keep polling */
    }
  }, 2000);
}

main().catch((error) => {
  showOverlay("Viewer failed to start", error instanceof Error ? error.stack || error.message : String(error));
  pollForRecovery(null);
});

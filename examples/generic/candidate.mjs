import * as THREE from "three";

function part(id, geometry, position = [0, 0, 0], critical = false) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x66705a, roughness: 0.72 }));
  mesh.name = id;
  mesh.userData.semanticId = id;
  mesh.userData.critical = critical;
  mesh.position.set(...position);
  return mesh;
}

export function createCandidate() {
  const root = new THREE.Group();
  root.name = "procedural-generic-example";
  root.userData.forwardAxis = "+z";
  root.add(part("primary", new THREE.BoxGeometry(4, 2, 3)));
  root.add(part("attachment", new THREE.BoxGeometry(1, 1, 1), [2.25, 0, 0]));
  root.add(part("identity-fitting", new THREE.CylinderGeometry(0.35, 0.35, 1, 8), [0, 1.5, 0], true));
  return root;
}

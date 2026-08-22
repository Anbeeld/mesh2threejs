import * as THREE from "three";
import { createTrackCourseGeometry } from "../kit.js";

function mesh(id: string, geometry: THREE.BufferGeometry, position: [number, number, number] = [0, 0, 0], critical = false): THREE.Mesh {
  const result = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x66705a, roughness: 0.72 }));
  result.name = id;
  result.userData.semanticId = id;
  result.userData.critical = critical;
  result.position.set(...position);
  return result;
}

export function analyticalGeneric(): THREE.Group {
  const root = new THREE.Group();
  root.name = "analytical-generic";
  root.userData.forwardAxis = "+z";
  root.add(mesh("primary", new THREE.BoxGeometry(4, 2, 3)));
  root.add(mesh("attachment", new THREE.BoxGeometry(1, 1, 1), [2.25, 0, 0]));
  root.add(mesh("identity-fitting", new THREE.CylinderGeometry(0.35, 0.35, 1, 8), [0, 1.5, 0], true));
  return root;
}

export function analyticalTank(): THREE.Group {
  const root = new THREE.Group();
  root.name = "analytical-tank";
  root.userData.forwardAxis = "+z";
  root.add(mesh("hull", new THREE.BoxGeometry(3.2, 1.2, 6), [0, 0.4, 0]));
  root.add(mesh("hull-upper", new THREE.BoxGeometry(2.8, 0.6, 3.8), [0, 1.25, -0.2]));
  const turretPivot = new THREE.Group();
  turretPivot.name = "turret-pivot";
  turretPivot.userData.semanticId = "turret-pivot";
  turretPivot.position.set(0, 1.8, -0.25);
  const turret = mesh("turret", new THREE.CylinderGeometry(1.15, 1.3, 0.9, 12));
  turret.rotation.x = Math.PI / 2;
  turretPivot.add(turret);
  const gunPivot = new THREE.Group();
  gunPivot.name = "gun-pivot";
  gunPivot.userData.semanticId = "gun-pivot";
  gunPivot.position.set(0, 0, 0.8);
  const gun = mesh("gun", new THREE.CylinderGeometry(0.12, 0.12, 3.4, 8), [0, 0, 1.7]);
  gun.rotation.x = Math.PI / 2;
  gunPivot.add(gun);
  turretPivot.add(gunPivot);
  turretPivot.add(mesh("cupola", new THREE.CylinderGeometry(0.35, 0.4, 0.35, 8), [0.35, 0.6, -0.1], true));
  root.add(turretPivot);
  for (const side of [-1, 1]) {
    for (let index = 0; index < 5; index += 1) {
      const wheel = mesh(`road-wheel-${side}-${index}`, new THREE.CylinderGeometry(0.55, 0.55, 0.22, 10), [side * 1.55, 0, -2 + index]);
      wheel.rotation.z = Math.PI / 2;
      wheel.userData.semanticRole = "road-wheel";
      root.add(wheel);
    }
    const track = mesh(`track-${side}`, createTrackCourseGeometry(5.5, 1.25, 0.25, 0.35), [side * 1.7, 0.05, 0]);
    track.userData.semanticRole = "track-course";
    root.add(track);
  }
  return root;
}

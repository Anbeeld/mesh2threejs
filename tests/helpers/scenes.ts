import * as THREE from "three";

export function semanticMesh(
  id: string,
  geometry: THREE.BufferGeometry,
  position: [number, number, number] = [0, 0, 0],
  options: { color?: number; roughness?: number; critical?: boolean } = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: options.color ?? 0x6f775f,
      roughness: options.roughness ?? 0.7,
    }),
  );
  mesh.name = id;
  mesh.position.set(...position);
  mesh.userData.semanticId = id;
  mesh.userData.critical = options.critical ?? false;
  return mesh;
}

export function createGenericFixture(options: {
  depth?: number;
  detached?: boolean;
  mirrored?: boolean;
  includeCritical?: boolean;
} = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "generic-root";
  root.userData.forwardAxis = options.mirrored ? "-z" : "+z";
  root.add(semanticMesh("primary", new THREE.BoxGeometry(4, 2, options.depth ?? 3)));
  root.add(
    semanticMesh(
      "attachment",
      new THREE.BoxGeometry(1, 1, 1),
      [options.detached ? 5 : 2.25, 0, 0],
    ),
  );
  if (options.includeCritical !== false) {
    root.add(
      semanticMesh("identity-fitting", new THREE.CylinderGeometry(0.35, 0.35, 1, 8), [0, 1.5, 0], {
        critical: true,
      }),
    );
  }
  return root;
}

export function createTankFixture(options: {
  wheelRadius?: number;
  wheelShift?: number;
  wheelSegments?: number;
  turretShift?: number;
  gunLength?: number;
  hullSlope?: number;
  omitCupola?: boolean;
  detachTurretItem?: boolean;
  reverse?: boolean;
  omitWheel?: boolean;
  omitTrack?: boolean;
  openHull?: boolean;
} = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "tank-root";
  root.userData.forwardAxis = options.reverse ? "-z" : "+z";

  const hull = semanticMesh("hull", options.openHull ? new THREE.PlaneGeometry(3.2, 6) : new THREE.BoxGeometry(3.2, 1.2, 6), [0, 0.4, 0]);
  const upperHull = semanticMesh("hull-upper", new THREE.BoxGeometry(2.8, 0.6, 3.8), [0, 1.25, -0.2]);
  upperHull.rotation.x = options.hullSlope ?? 0;
  root.add(hull, upperHull);

  const turretPivot = new THREE.Group();
  turretPivot.name = "turret-pivot";
  turretPivot.userData.semanticId = "turret-pivot";
  turretPivot.position.set(options.turretShift ?? 0, 1.8, -0.25);
  const turret = semanticMesh("turret", new THREE.CylinderGeometry(1.15, 1.3, 0.9, 12));
  turret.rotation.x = Math.PI / 2;
  turretPivot.add(turret);

  const gunPivot = new THREE.Group();
  gunPivot.name = "gun-pivot";
  gunPivot.userData.semanticId = "gun-pivot";
  gunPivot.position.set(0, 0, 0.8);
  const gunLength = options.gunLength ?? 3.4;
  const gun = semanticMesh("gun", new THREE.CylinderGeometry(0.12, 0.12, gunLength, 8), [0, 0, gunLength / 2]);
  gun.rotation.x = Math.PI / 2;
  gunPivot.add(gun);
  turretPivot.add(gunPivot);

  if (!options.omitCupola) {
    turretPivot.add(
      semanticMesh(
        "cupola",
        new THREE.CylinderGeometry(0.35, 0.4, 0.35, 8),
        [options.detachTurretItem ? 3 : 0.35, 0.6, -0.1],
        { critical: true },
      ),
    );
  }
  root.add(turretPivot);

  const wheelRadius = options.wheelRadius ?? 0.55;
  const shift = options.wheelShift ?? 0;
  for (const side of [-1, 1]) {
    for (let index = 0; index < 5; index += 1) {
      if (options.omitWheel && side === 1 && index === 4) continue;
      const wheel = semanticMesh(
        `road-wheel-${side}-${index}`,
        new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.22, options.wheelSegments ?? 16),
        [side * 1.55, 0, -2 + index + shift],
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.userData.semanticRole = "road-wheel";
      root.add(wheel);
    }
    if (!(options.omitTrack && side === 1)) {
      const track = semanticMesh(`track-${side}`, new THREE.BoxGeometry(0.25, 1.25, 5.5), [side * 1.7, 0.05, 0]);
      track.userData.semanticRole = "track-course";
      root.add(track);
    }
  }
  return root;
}

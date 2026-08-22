import type * as THREE from "three";

export type Point3 = [number, number, number];
export type Axis = "x" | "y" | "z";
export type ProfileId = "tank" | "generic";
export type CertificationLevel = "exact-real" | "oracle-relative";
export type CapturePass =
  | "beauty"
  | "alpha-silhouette"
  | "semantic-id"
  | "depth"
  | "normal"
  | "roughness-material-id";

export interface Bounds3 {
  min: Point3;
  max: Point3;
  size: Point3;
  center: Point3;
}

export interface SceneTriangle {
  points: [Point3, Point3, Point3];
  normal: Point3;
  componentId: string;
  materialId: string;
  color: number;
  roughness: number;
}

export interface SceneComponent {
  id: string;
  name: string;
  role?: string;
  parentSemanticId?: string;
  critical: boolean;
  triangleIndices: number[];
  bounds: Bounds3;
}

export interface SceneSnapshot {
  triangles: SceneTriangle[];
  components: Record<string, SceneComponent>;
  meshCount: number;
  materialCount: number;
  triangleCount: number;
  metadata: {
    name: string;
    forwardAxis?: string;
  };
}

export interface RenderProfile {
  schemaVersion: "render-profile.v1";
  renderer: {
    backend: "deterministic-cpu";
    colorManagement: "linear-srgb-to-srgb";
    toneMapping: "neutral";
    exposure: number;
    width: number;
    height: number;
    devicePixelRatio: 1;
    antialias: false;
  };
  background: [number, number, number, number];
  environment: { kind: "fixed-directional"; intensity: number };
  camera: { near: number; far: number; orthographicHeight: number; perspectiveFov: number };
  passes: CapturePass[];
}

export interface CaptureCamera {
  id: string;
  projection: "orthographic" | "perspective";
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

export interface CaptureFrame {
  pass: CapturePass;
  cameraId: string;
  width: number;
  height: number;
  data: Uint8Array;
  profileHash: string;
}

export type Severity = "critical" | "major" | "minor";

export interface GateRow {
  code: string;
  component: string;
  passed: boolean;
  score: number;
  severity: Severity;
  message: string;
  oracleValue?: number | string;
  candidateValue?: number | string;
  deviation?: number;
  normalizedDeviation?: number;
  view?: string;
  position?: number;
}

export interface Workorder {
  component: string;
  view?: string;
  position?: number;
  oracleValue?: number | string;
  candidateValue?: number | string;
  absoluteDeviation?: number;
  normalizedDeviation?: number;
  errorKind: string;
  priority: Severity;
  correction: string;
}

export interface GateReport {
  profile: ProfileId;
  passed: boolean;
  score: number;
  rows: GateRow[];
  workorders: Workorder[];
}

export interface CandidateModule {
  createCandidate: () => THREE.Object3D | Promise<THREE.Object3D>;
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGlbScene, loadPreparedOracle, onboardOracle, probeGlb, snapshotScene, PerformanceRecorder } from "../src/index.js";

/**
 * Generated large-GLB intake coverage. Unlike the direct BufferGeometry synthetic workload, this
 * exercises the real intake path: GLB bytes -> accessor decode -> node transforms -> Three.js scene
 * -> preparation -> snapshot, so transient decoder and preparation memory is measured.
 */

interface GeneratedGlb {
  bytes: Buffer;
  triangles: number;
}

function buildGlb(meshCount: number, trianglesPerMesh: number, withNormalsMask: number): GeneratedGlb {
  const binChunks: Buffer[] = [];
  const bufferViews: Array<Record<string, number>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  const meshes: Array<Record<string, unknown>> = [];
  const nodes: Array<Record<string, unknown>> = [];
  let binOffset = 0;
  const push = (values: Float32Array): number => {
    const chunk = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    const padded = Buffer.concat([chunk, Buffer.alloc((4 - (chunk.length % 4)) % 4)]);
    const view = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: chunk.length });
    binChunks.push(padded);
    binOffset += padded.length;
    return view;
  };
  const makeMeshPositions = (meshIndex: number): Float32Array => {
    const values = new Float32Array(trianglesPerMesh * 9);
    for (let triangle = 0; triangle < trianglesPerMesh; triangle += 1) {
      const offset = triangle * 9;
      const column = triangle % 256;
      const row = Math.floor(triangle / 256) % 256;
      const base = meshIndex * 300 + column;
      values.set([base, row, 0, base + 0.5, row, 0, base, row + 0.5, 0], offset);
    }
    return values;
  };
  for (let meshIndex = 0; meshIndex < meshCount; meshIndex += 1) {
    const positions = makeMeshPositions(meshIndex);
    let min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    let max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (let index = 0; index < positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis]!, positions[index + axis]!);
        max[axis] = Math.max(max[axis]!, positions[index + axis]!);
      }
    }
    const positionView = push(positions);
    const positionAccessor = accessors.length;
    accessors.push({ bufferView: positionView, componentType: 5126, count: positions.length / 3, type: "VEC3", min, max });
    const attributes: Record<string, number> = { POSITION: positionAccessor };
    if (withNormalsMask & (1 << meshIndex)) {
      const normals = new Float32Array(trianglesPerMesh * 9);
      for (let index = 0; index < normals.length; index += 3) normals.set([0, 0, 1], index);
      const normalView = push(normals);
      attributes.NORMAL = accessors.length;
      accessors.push({ bufferView: normalView, componentType: 5126, count: normals.length / 3, type: "VEC3" });
    }
    meshes.push({ primitives: [{ attributes }], name: `part-${meshIndex}` });
    nodes.push({
      mesh: meshIndex,
      name: `part-${meshIndex}`,
      translation: [meshIndex * 2.5, 0, 0],
      ...(meshIndex === meshCount - 1 ? { rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [0.5, 0.5, 0.5] } : {}),
    });
  }
  const json = {
    asset: { version: "2.0", generator: "mesh2threejs-glb-ingest-benchmark" },
    buffers: [{ byteLength: binOffset }],
    bufferViews,
    accessors,
    meshes,
    nodes,
    scenes: [{ nodes: nodes.map((_, index) => index) }],
    scene: 0,
  };
  let jsonBytes = Buffer.from(JSON.stringify(json));
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const bin = Buffer.concat(binChunks);
  const output = Buffer.alloc(12 + 8 + jsonBytes.length + 8 + bin.length);
  output.write("glTF", 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonBytes.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(output, 20);
  const binHeader = 20 + jsonBytes.length;
  output.writeUInt32LE(bin.length, binHeader);
  output.writeUInt32LE(0x004e4942, binHeader + 4);
  bin.copy(output, binHeader + 8);
  return { bytes: output, triangles: meshCount * trianglesPerMesh };
}

const totalTriangles = Number(process.env.MESH2THREEJS_BENCH_GLB_TRIANGLES ?? 1_000_000);
if (!Number.isInteger(totalTriangles) || totalTriangles < 1) throw new Error("MESH2THREEJS_BENCH_GLB_TRIANGLES must be a positive integer");
const meshCount = 8;
const { bytes, triangles } = buildGlb(meshCount, Math.ceil(totalTriangles / meshCount), 0b01010101);
const performance = new PerformanceRecorder();
const temporary = await mkdtemp(join(tmpdir(), "mesh2threejs-glb-ingest-"));
try {
  const probe = performance.measure("glb-byte-probe", () => probeGlb(bytes));
  const scene = performance.measure("glb-accessor-node-scene-load", () => loadGlbScene(bytes));
  const snapshot = performance.measure("loaded-scene-snapshot", () => snapshotScene(scene));
  const sourcePath = join(temporary, "source.glb");
  await writeFile(sourcePath, bytes);
  const manifest = await performance.measureAsync("glb-preparation-onboard", () => onboardOracle({
    id: "ingest-benchmark", sourcePath, preparedPath: join(temporary, "prepared.json"), source: "generated intake benchmark", author: "mesh2threejs", license: "generated fixture", redistribution: "allowed",
    coordinateFrame: "right-handed", upAxis: "+y", forwardAxis: "+z", grounding: "min-y=0", scale: 1,
    semanticMap: Object.fromEntries(Array.from({ length: meshCount }, (_, index) => [`node:${index}`, index === 0 ? "primary" : `detail-${index}`])),
    articulationMap: {}, normalization: { translation: [0, 1, 0], rotationEuler: [0, 0, 0], scale: 1 },
    authoritativeDimensions: null, dimensionSources: [],
  }));
  const prepared = await performance.measureAsync("prepared-oracle-load", () => loadPreparedOracle(manifest));
  const preparedSnapshot = performance.measure("prepared-scene-snapshot", () => snapshotScene(prepared));
  const report = performance.report();
  const result = {
    workload: "generated large-GLB intake: bytes -> accessor decode -> node transforms -> scene -> preparation -> snapshot",
    inputGlbBytes: bytes.byteLength,
    triangles,
    probedTriangles: snapshot.triangleCount,
    preparedTriangles: preparedSnapshot.triangleCount,
    probeNodes: probe.scene.nodeCount,
    snapshotBytes: snapshot.triangleData.positions.byteLength,
    ...report,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  const elapsed = report.operators.reduce((sum, row) => sum + row.elapsedMs, 0);
  const rssCeiling = 8 * 1024 ** 3;
  if (elapsed > 180_000) throw new Error(`large-GLB intake exceeded 180s ceiling: ${elapsed.toFixed(1)}ms`);
  if (report.peakObservedRssBytes > rssCeiling) throw new Error(`large-GLB intake exceeded 8 GiB observed RSS ceiling: ${(report.peakObservedRssBytes / 1024 ** 3).toFixed(2)} GiB`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

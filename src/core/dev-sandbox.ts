import { createInProcessBackend, type SandboxBackend } from "./candidate-sandbox.js";

/**
 * Development-only sandbox: imports the staged graph in THIS process. It provides no
 * isolation boundary, is never classified trusted-isolated, and can never certify.
 */
export function developmentInProcessBackend(): SandboxBackend {
  return createInProcessBackend(async (entryHref: string) => {
    const imported = await import(entryHref) as { createCandidate?: () => Promise<unknown> | unknown };
    if (!imported || typeof imported.createCandidate !== "function") throw new Error("candidate module must export createCandidate()");
    const built = await imported.createCandidate() as { root?: unknown; setPose?: unknown; isObject3D?: boolean } | null;
    if (built && "root" in built && typeof built.setPose === "function" && (built.root as { isObject3D?: boolean } | null | undefined)?.isObject3D === true) {
      return { root: built.root as import("three").Object3D, setPose: built.setPose as (pose: Record<string, number>) => void | Promise<void> };
    }
    if (built?.isObject3D === true) {
      return { root: built as unknown as import("three").Object3D, setPose: () => { throw new Error("candidate does not expose physical articulation controls"); } };
    }
    throw new Error("createCandidate() must return a THREE.Object3D or candidate runtime");
  });
}

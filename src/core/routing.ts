import type { ProfileId } from "../types.js";

export type Route = "reconstruct" | "onboard-oracle" | "repair-oracle" | "build" | "visual-review" | "finalize" | "diagnose";
export type RouteAction =
  | "initialize-state"
  | "edit-prepared-oracle"
  | "edit-candidate"
  | "render"
  | "run-gates"
  | "issue-verdict"
  | "certify"
  | "recommend-transition"
  | "edit-oracle";

const PERMISSIONS: Record<Route, ReadonlySet<RouteAction>> = {
  reconstruct: new Set(["initialize-state", "render", "run-gates", "recommend-transition"]),
  "onboard-oracle": new Set(["edit-prepared-oracle", "render", "run-gates"]),
  "repair-oracle": new Set(["edit-prepared-oracle", "render", "run-gates"]),
  build: new Set(["edit-candidate", "render", "run-gates"]),
  "visual-review": new Set(["render", "run-gates", "issue-verdict"]),
  finalize: new Set(["render", "run-gates", "certify"]),
  diagnose: new Set(["render", "run-gates", "recommend-transition"]),
};

export function assertRoutePermission(route: Route, action: RouteAction): void {
  if (!PERMISSIONS[route].has(action)) throw new Error(`${action} is not permitted in the ${route} route`);
}

export function routeSubject(prompt: string): ProfileId {
  const normalized = prompt.toLowerCase();
  const explicitTank = /\b(tank|main battle tank|mbt|tracked armored|tracked armoured|turreted armored|turreted armoured)\b/u.test(normalized);
  const tankSemantics = /\b(track|tracked)\b/u.test(normalized) && /\b(turret|gun|cannon)\b/u.test(normalized) && /\b(vehicle|armor|armour)\b/u.test(normalized);
  return explicitTank || tankSemantics ? "tank" : "generic";
}

export const routePermissions = PERMISSIONS;

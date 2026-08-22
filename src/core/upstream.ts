export interface UpstreamPin {
  id: string;
  repo: string;
  pinnedCommit: string;
  relevantPrefixes: string[];
}

export interface UpstreamDrift {
  id: string;
  pinnedCommit: string;
  currentCommit: string;
  changed: boolean;
  relevantChangedPaths: string[];
  compareUrl: string;
}

export const upstreamPins: UpstreamPin[] = [
  { id: "claude-of-tanks", repo: "Kevin-Liu-01/Claude-of-Tanks", pinnedCommit: "f389f13f829451d64cf780c5f14473527b45f7f4", relevantPrefixes: ["docs/GEOMETRY-GATE", "docs/BUILD-STANDARD", "docs/handoff/", "tools/geometry-gate", "tools/vertex-", "tools/reference-glb-loader", "tools/track-system-audit", "src/vehicles/profiles/", "src/vehicles/suspensionPatterns"] },
  { id: "img2threejs", repo: "img2threejs/img2threejs", pinnedCommit: "d6673386f89673a58736f8d398dd16ece67874f5", relevantPrefixes: [""] },
  { id: "prompting", repo: "Anbeeld/PROMPTING.md", pinnedCommit: "ea8c5e7e22134ac57984d67a2cdc7c29c7c4ba90", relevantPrefixes: [""] },
];

export async function inspectUpstreamDrift(pin: UpstreamPin): Promise<UpstreamDrift> {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "mesh2threejs-upstream-audit" };
  const commitResponse = await fetch(`https://api.github.com/repos/${pin.repo}/commits/HEAD`, { headers });
  if (!commitResponse.ok) throw new Error(`cannot inspect ${pin.repo} HEAD: HTTP ${commitResponse.status}`);
  const current = await commitResponse.json() as { sha?: unknown };
  if (typeof current.sha !== "string") throw new Error(`${pin.repo} returned no HEAD commit`);
  const compareUrl = `https://github.com/${pin.repo}/compare/${pin.pinnedCommit}...${current.sha}`;
  if (current.sha === pin.pinnedCommit) return { id: pin.id, pinnedCommit: pin.pinnedCommit, currentCommit: current.sha, changed: false, relevantChangedPaths: [], compareUrl };
  const comparisonResponse = await fetch(`https://api.github.com/repos/${pin.repo}/compare/${pin.pinnedCommit}...${current.sha}`, { headers });
  if (!comparisonResponse.ok) throw new Error(`cannot compare ${pin.repo}: HTTP ${comparisonResponse.status}`);
  const comparison = await comparisonResponse.json() as { files?: Array<{ filename?: unknown }> };
  const paths = (comparison.files ?? []).map((file) => file.filename).filter((value): value is string => typeof value === "string");
  return { id: pin.id, pinnedCommit: pin.pinnedCommit, currentCommit: current.sha, changed: true, relevantChangedPaths: paths.filter((path) => pin.relevantPrefixes.some((prefix) => path.startsWith(prefix))), compareUrl };
}

export async function inspectAllUpstreamDrift(): Promise<UpstreamDrift[]> {
  return await Promise.all(upstreamPins.map(inspectUpstreamDrift));
}

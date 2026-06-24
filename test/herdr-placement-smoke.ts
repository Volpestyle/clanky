import { paneMatchesPlacement, resolveClankyFacePanePlacement } from "../agent/lib/herdr-placement.ts";

function check(name: string, condition: boolean): void {
	if (!condition) throw new Error(name);
	console.log(`ok    ${name}`);
}

const KEYS = [
	"CLANKY_FACE_HERDR_WORKSPACE_ID",
	"CLANKY_FACE_HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
	"HERDR_TAB_ID",
] as const;
const saved = new Map<string, string | undefined>(KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function clearPlacementEnv(): void {
	for (const key of KEYS) delete process.env[key];
}

try {
	clearPlacementEnv();
	process.env.CLANKY_FACE_HERDR_WORKSPACE_ID = "w-face";
	process.env.CLANKY_FACE_HERDR_TAB_ID = "t-face";
	process.env.HERDR_WORKSPACE_ID = "w-inherited";
	process.env.HERDR_TAB_ID = "t-inherited";
	const facePlacement = await resolveClankyFacePanePlacement();
	check("face placement env wins", facePlacement.workspace_id === "w-face" && facePlacement.tab_id === "t-face");

	clearPlacementEnv();
	process.env.HERDR_WORKSPACE_ID = "w-inherited";
	process.env.HERDR_TAB_ID = "t-inherited";
	const inheritedPlacement = await resolveClankyFacePanePlacement();
	check(
		"inherited herdr placement is fallback",
		inheritedPlacement.workspace_id === "w-inherited" && inheritedPlacement.tab_id === "t-inherited",
	);

	check(
		"pane placement matches exact tab/workspace",
		paneMatchesPlacement({ workspace_id: "w-inherited", tab_id: "t-inherited" }, inheritedPlacement),
	);
	check(
		"pane placement rejects wrong tab",
		!paneMatchesPlacement({ workspace_id: "w-inherited", tab_id: "t-other" }, inheritedPlacement),
	);

	console.log("\nALL OK");
} finally {
	restoreEnv();
}

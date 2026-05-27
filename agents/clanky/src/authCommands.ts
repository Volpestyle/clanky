import {
	type ClankyCommandCompletionSpec,
	completeClankyCommandArgument,
	DEFAULT_ELEVENLABS_PROVIDER_ID,
	DEFAULT_OPENAI_PROVIDER_ID,
	DEFAULT_XAI_PROVIDER_ID,
} from "@clanky/core";
import type { AuthStorage, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ClankyDiscordGatewayController } from "./discordGatewayController.ts";

export interface ClankyAuthCommandDeps {
	authStorage: AuthStorage;
	authFilePath: string;
	discordProviderId: string;
	gatewayController?: ClankyDiscordGatewayController;
}

type ParsedAuthCommand =
	| {
			action: "list";
	  }
	| {
			action: "remove";
			provider: string;
	  };

const KNOWN_AUTH_PROVIDER_IDS = [
	DEFAULT_OPENAI_PROVIDER_ID,
	DEFAULT_XAI_PROVIDER_ID,
	DEFAULT_ELEVENLABS_PROVIDER_ID,
] as const;

const AUTH_STATIC_COMPLETIONS = [
	{ value: "list", description: "List stored profile credentials." },
	{ value: "status", description: "List stored profile credentials." },
	{ value: "remove all", description: "Remove every stored profile credential." },
	{ value: "logout all", description: "Remove every stored profile credential." },
] satisfies readonly ClankyCommandCompletionSpec[];

export function createClankyAuthExtensionFactory(deps: ClankyAuthCommandDeps): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("auth", {
			description: "List or remove stored provider credentials in this Clanky profile",
			getArgumentCompletions: (prefix) => {
				const providerCompletions = authProviderCompletions(deps).flatMap((provider) => [
					{
						value: `remove ${provider}`,
						description: `Remove stored ${provider} credentials from this profile.`,
					},
					{
						value: `logout ${provider}`,
						description: `Remove stored ${provider} credentials from this profile.`,
					},
				]);
				return completeClankyCommandArgument(prefix, [...AUTH_STATIC_COMPLETIONS, ...providerCompletions]);
			},
			handler: async (args, ctx) => {
				try {
					await runClankyAuthCommand(deps, String(args ?? ""), ctx);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Auth command error: ${message}`, "error");
				}
			},
		});
	};
}

async function runClankyAuthCommand(
	deps: ClankyAuthCommandDeps,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const parsed = parseAuthCommandArgs(args);
	if (parsed === undefined) {
		ctx.ui.notify(formatAuthUsage(deps), "warning");
		return;
	}
	if (parsed.action === "list") {
		ctx.ui.notify(formatStoredAuthList(deps));
		return;
	}

	const provider = parsed.provider;
	if (provider === "all") {
		await removeAllStoredCredentials(deps, ctx);
		return;
	}
	await removeStoredCredential(deps, provider, ctx);
}

function parseAuthCommandArgs(args: string): ParsedAuthCommand | undefined {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { action: "list" };
	const command = parts[0]?.toLowerCase();
	if (parts.length === 1 && (command === "list" || command === "status")) return { action: "list" };
	if (
		(command === "remove" || command === "rm" || command === "delete" || command === "logout") &&
		parts.length === 2
	) {
		const provider = parts[1]?.trim();
		if (provider !== undefined && provider.length > 0) return { action: "remove", provider };
	}
	return undefined;
}

function formatStoredAuthList(deps: ClankyAuthCommandDeps): string {
	const providers = deps.authStorage.list().sort((a, b) => a.localeCompare(b));
	const lines = ["Stored auth"];
	if (providers.length === 0) {
		lines.push("No credentials are stored in this Clanky profile.");
	} else {
		for (const provider of providers) {
			const credential = deps.authStorage.get(provider);
			lines.push(`- ${provider}: ${credential?.type ?? "unknown"}`);
		}
	}
	lines.push("", `Profile auth file: ${deps.authFilePath}`);
	lines.push("Use /auth remove <provider> or /auth remove all.");
	lines.push("Environment variables and models.json request auth are not changed by this command.");
	return lines.join("\n");
}

function formatAuthUsage(deps: ClankyAuthCommandDeps): string {
	const providers = authProviderCompletions(deps);
	return [
		"Auth",
		"Usage: /auth [list|status]",
		"Usage: /auth remove <provider|all>",
		`Known providers: ${providers.join(", ")}`,
		"Environment variables and models.json request auth are not changed by this command.",
	].join("\n");
}

async function removeStoredCredential(
	deps: ClankyAuthCommandDeps,
	provider: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const existing = deps.authStorage.get(provider);
	if (existing === undefined) {
		ctx.ui.notify(`No stored credential under provider "${provider}".`);
		return;
	}
	deps.authStorage.remove(provider);
	const lines = [
		`Removed stored ${existing.type} credential for provider "${provider}" from ${deps.authFilePath}.`,
		"Environment variables and models.json request auth were not changed.",
	];
	await applyAuthRemovalSideEffects(deps, [provider], lines);
	lines.push("Reloading session to refresh auth and model availability.");
	ctx.ui.notify(lines.join("\n"));
	await ctx.reload();
}

async function removeAllStoredCredentials(deps: ClankyAuthCommandDeps, ctx: ExtensionCommandContext): Promise<void> {
	const providers = deps.authStorage.list().sort((a, b) => a.localeCompare(b));
	if (providers.length === 0) {
		ctx.ui.notify("No stored credentials to remove from this Clanky profile.");
		return;
	}
	const confirmed = await ctx.ui.confirm(
		"Remove all stored provider credentials?",
		`This removes ${providers.length} stored credential(s) from ${deps.authFilePath}. Environment variables are unchanged.`,
	);
	if (!confirmed) {
		ctx.ui.notify("Auth removal cancelled; stored credentials left unchanged.");
		return;
	}
	for (const provider of providers) deps.authStorage.remove(provider);
	const lines = [
		`Removed stored credentials for: ${providers.join(", ")}.`,
		"Environment variables and models.json request auth were not changed.",
	];
	await applyAuthRemovalSideEffects(deps, providers, lines);
	lines.push("Reloading session to refresh auth and model availability.");
	ctx.ui.notify(lines.join("\n"));
	await ctx.reload();
}

async function applyAuthRemovalSideEffects(
	deps: ClankyAuthCommandDeps,
	removedProviders: readonly string[],
	lines: string[],
): Promise<void> {
	const touchesDiscordGateway =
		removedProviders.includes(deps.discordProviderId) || removedProviders.includes(DEFAULT_ELEVENLABS_PROVIDER_ID);
	if (!touchesDiscordGateway || deps.gatewayController === undefined) return;
	try {
		await deps.gatewayController.restart();
		lines.push("Discord bridge restarted after auth removal.");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		lines.push(`Failed to restart Discord bridge after auth removal: ${message}. Restart Clanky to recover.`);
	}
}

function authProviderCompletions(deps: ClankyAuthCommandDeps): string[] {
	const providers = new Set<string>([...KNOWN_AUTH_PROVIDER_IDS, deps.discordProviderId, ...deps.authStorage.list()]);
	return [...providers].sort((a, b) => a.localeCompare(b));
}

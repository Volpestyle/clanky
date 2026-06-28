/**
 * Clanky menu-step protocol — the single cross-process/cross-repo contract for
 * mirroring the conductor's interactive command menus.
 *
 * Clanky defines every command menu once, against the `SetupFlow` interface in
 * `scripts/clanky.ts`; the pi-tui renderer is one implementation. To drive those
 * same menus from the Clanky iOS app we add a second `SetupFlow` implementation
 * (`RemoteSetupFlow`) that, instead of drawing overlays, serializes each
 * step as a `ClankyMenuServerEvent` and resolves its `readSelect` / `readText`
 * promises from a `ClankyMenuClientMessage`.
 *
 * The Swift side mirrors these shapes in `clanky-ios/ClankyIOS/Models/
 * ClankyMenuSession.swift`. Keep the two in sync. See
 * `clanky-ios/docs/native-menu-mirroring.md`.
 *
 * Types only — no behavior — so this module is safe to import from either the
 * face process (where command handlers run) or the relay/eve server process.
 */

export type ClankyMenuTone = "info" | "success" | "warning" | "error";

/** One selectable option — mirrors clanky's `MenuOption`. */
export interface ClankyMenuProtocolOption {
	readonly value: string;
	readonly label: string;
	readonly hint?: string;
	readonly description?: string;
}

/** A `flow.readSelect(...)` step. */
export interface ClankyMenuSelectStep {
	readonly stepId: string;
	readonly message: string;
	readonly kind: "single" | "multi";
	readonly options: readonly ClankyMenuProtocolOption[];
	readonly statusActions?: readonly ClankyMenuProtocolOption[];
	readonly currentValues?: readonly string[];
	readonly required?: boolean;
	readonly allowBack?: boolean;
}

/** A `flow.readText(...)` step. */
export interface ClankyMenuTextStep {
	readonly stepId: string;
	readonly message: string;
	readonly placeholder?: string;
	readonly defaultValue?: string;
	readonly allowBack?: boolean;
}

/**
 * Server → client. Emitted by `RemoteSetupFlow` as the command runs. `sessionId`
 * scopes a single menu invocation; `stepId` correlates a step with its response.
 */
export type ClankyMenuServerEvent =
	| { readonly type: "menu.begin"; readonly sessionId: string; readonly command: string; readonly title: string }
	| ({ readonly type: "menu.select"; readonly sessionId: string } & ClankyMenuSelectStep)
	| ({ readonly type: "menu.text"; readonly sessionId: string } & ClankyMenuTextStep)
	| { readonly type: "menu.line"; readonly sessionId: string; readonly text: string; readonly tone?: ClankyMenuTone }
	| { readonly type: "menu.status"; readonly sessionId: string; readonly text?: string }
	| { readonly type: "menu.end"; readonly sessionId: string; readonly message: string }
	| { readonly type: "menu.failed"; readonly sessionId: string; readonly message: string };

/**
 * Client → server. `menu.respond` resolves the pending `readSelect`/`readText`;
 * `menu.back` resolves it with `undefined` (handlers step back); `menu.cancel`
 * is the equivalent of typing `/cancel`.
 */
export type ClankyMenuClientMessage =
	| { readonly type: "menu.respond"; readonly sessionId: string; readonly stepId: string; readonly values?: readonly string[]; readonly text?: string }
	| { readonly type: "menu.back"; readonly sessionId: string; readonly stepId: string }
	| { readonly type: "menu.cancel"; readonly sessionId: string };

/** Catalog entry returned by the planned relay `list-commands` op. */
export interface ClankyMenuCommandSpec {
	readonly name: string;
	readonly aliases: readonly string[];
	readonly description: string;
	readonly argumentHint?: string;
	readonly category: string;
	/** Whether the command opens an interactive menu (vs. a one-shot action). */
	readonly interactive: boolean;
}

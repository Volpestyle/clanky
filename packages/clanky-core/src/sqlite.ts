import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

export type DatabaseSyncConstructor = new (path: string) => DatabaseSync;

type WarningConstructor = NonNullable<NodeJS.EmitWarningOptions["ctor"]>;
type EmitWarningFunction = (
	warning: string | Error,
	optionsOrType?: string | NodeJS.EmitWarningOptions | WarningConstructor,
	codeOrCtor?: string | WarningConstructor,
	ctor?: WarningConstructor,
) => void;

const require = createRequire(import.meta.url);
let DatabaseSyncClass: DatabaseSyncConstructor | undefined;

export function loadDatabaseSync(): DatabaseSyncConstructor {
	if (DatabaseSyncClass !== undefined) return DatabaseSyncClass;

	const originalEmitWarning = process.emitWarning as EmitWarningFunction;
	const filteredEmitWarning: EmitWarningFunction = (warning, optionsOrType, codeOrCtor, ctor) => {
		const message = typeof warning === "string" ? warning : warning.message;
		const type =
			typeof optionsOrType === "string"
				? optionsOrType
				: typeof optionsOrType === "object" && optionsOrType !== null
					? optionsOrType.type
					: undefined;
		if (message.includes("SQLite is an experimental feature") && type === "ExperimentalWarning") return;
		if (typeof optionsOrType === "function") {
			originalEmitWarning.call(process, warning, optionsOrType);
		} else if (typeof optionsOrType === "object") {
			originalEmitWarning.call(process, warning, optionsOrType);
		} else if (typeof codeOrCtor === "function") {
			originalEmitWarning.call(process, warning, optionsOrType, codeOrCtor);
		} else if (ctor !== undefined) {
			originalEmitWarning.call(process, warning, optionsOrType, codeOrCtor, ctor);
		} else if (codeOrCtor !== undefined) {
			originalEmitWarning.call(process, warning, optionsOrType, codeOrCtor);
		} else if (optionsOrType !== undefined) {
			originalEmitWarning.call(process, warning, optionsOrType);
		} else {
			originalEmitWarning.call(process, warning);
		}
	};

	process.emitWarning = filteredEmitWarning as typeof process.emitWarning;
	try {
		const sqlite = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };
		DatabaseSyncClass = sqlite.DatabaseSync;
		return DatabaseSyncClass;
	} finally {
		process.emitWarning = originalEmitWarning as typeof process.emitWarning;
	}
}

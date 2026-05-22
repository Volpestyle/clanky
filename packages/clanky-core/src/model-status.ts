import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type ResolveClankyPathsOptions, resolveClankyPaths } from "./paths.ts";

export interface ModelCredentialsStatus {
	authProviders: string[];
	availableModels: number;
	availableProviders: string[];
	configured: boolean;
	modelConfigError?: string;
	totalModels: number;
	totalProviders: string[];
}

export function getModelCredentialsStatus(options: ResolveClankyPathsOptions = {}): ModelCredentialsStatus {
	const paths = resolveClankyPaths(options);
	const authStorage = AuthStorage.create(paths.authFile);
	const modelRegistry = ModelRegistry.create(authStorage, paths.modelsFile);
	const allModels = modelRegistry.getAll();
	const availableModels = modelRegistry.getAvailable();
	const modelConfigError = modelRegistry.getError();
	const status: ModelCredentialsStatus = {
		authProviders: sortedUnique(authStorage.list()),
		availableModels: availableModels.length,
		availableProviders: sortedUnique(availableModels.map((model) => model.provider)),
		configured: availableModels.length > 0,
		totalModels: allModels.length,
		totalProviders: sortedUnique(allModels.map((model) => model.provider)),
	};
	if (modelConfigError !== undefined) status.modelConfigError = modelConfigError;
	return status;
}

function sortedUnique(values: string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

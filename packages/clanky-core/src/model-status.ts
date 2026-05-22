import { type AuthStatus, AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
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

export interface ModelAuthProviderStatus extends AuthStatus {
	provider: string;
}

export interface ModelAuthStatus extends ModelCredentialsStatus {
	authFile: string;
	providers: ModelAuthProviderStatus[];
}

export interface SetModelApiKeyInput {
	apiKey: string;
	provider: string;
}

export interface ModelAuthMutationResult {
	provider: string;
	status: ModelAuthStatus;
}

export function getModelCredentialsStatus(options: ResolveClankyPathsOptions = {}): ModelCredentialsStatus {
	return getModelAuthStatus(options);
}

export function getModelAuthStatus(options: ResolveClankyPathsOptions = {}): ModelAuthStatus {
	const paths = resolveClankyPaths(options);
	const authStorage = AuthStorage.create(paths.authFile);
	const modelRegistry = ModelRegistry.create(authStorage, paths.modelsFile);
	const allModels = modelRegistry.getAll();
	const availableModels = modelRegistry.getAvailable();
	const modelConfigError = modelRegistry.getError();
	const providerIds = sortedUnique(["openai", ...allModels.map((model) => model.provider), ...authStorage.list()]);
	const status: ModelAuthStatus = {
		authFile: paths.authFile,
		authProviders: sortedUnique(authStorage.list()),
		availableModels: availableModels.length,
		availableProviders: sortedUnique(availableModels.map((model) => model.provider)),
		configured: availableModels.length > 0,
		providers: providerIds.map((provider) => ({ provider, ...modelRegistry.getProviderAuthStatus(provider) })),
		totalModels: allModels.length,
		totalProviders: sortedUnique(allModels.map((model) => model.provider)),
	};
	if (modelConfigError !== undefined) status.modelConfigError = modelConfigError;
	return status;
}

export function setStoredModelApiKey(
	options: ResolveClankyPathsOptions,
	input: SetModelApiKeyInput,
): ModelAuthMutationResult {
	const provider = sanitizeProvider(input.provider);
	const apiKey = sanitizeApiKey(input.apiKey);
	const paths = resolveClankyPaths(options);
	const authStorage = AuthStorage.create(paths.authFile);
	authStorage.set(provider, { type: "api_key", key: apiKey });
	const errors = authStorage.drainErrors();
	if (errors.length > 0) throw errors[0];
	return { provider, status: getModelAuthStatus(options) };
}

export function removeStoredModelAuth(
	options: ResolveClankyPathsOptions,
	providerInput: string,
): ModelAuthMutationResult {
	const provider = sanitizeProvider(providerInput);
	const paths = resolveClankyPaths(options);
	const authStorage = AuthStorage.create(paths.authFile);
	authStorage.remove(provider);
	const errors = authStorage.drainErrors();
	if (errors.length > 0) throw errors[0];
	return { provider, status: getModelAuthStatus(options) };
}

function sanitizeProvider(input: string): string {
	const provider = input.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(provider)) {
		throw new Error(`Invalid model provider: ${input}`);
	}
	return provider;
}

function sanitizeApiKey(input: string): string {
	const apiKey = input.replaceAll("\r", "").replaceAll("\n", "").trim();
	if (apiKey.length === 0) throw new Error("API key must not be empty");
	if (!/^[\x20-\x7e]+$/.test(apiKey)) {
		throw new Error("API key must contain only printable ASCII characters");
	}
	return apiKey;
}

function sortedUnique(values: string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

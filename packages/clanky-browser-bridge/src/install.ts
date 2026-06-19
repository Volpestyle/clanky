import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrowserBridgePaths, resolveBrowserBridgePort } from "./paths.ts";

export interface InstallOptions {
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
}

export interface InstallResult {
	bridgeDir: string;
	extensionDir: string;
	extensionId: string;
	configFile: string;
	extensionConfigFile: string;
	port: number;
	tokenPreview: string;
}

export async function installBrowserBridge(options: InstallOptions = {}): Promise<InstallResult> {
	const env = options.env ?? process.env;
	const paths = resolveBrowserBridgePaths({
		...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
		env,
	});
	await mkdir(paths.bridgeDir, { recursive: true, mode: 0o700 });
	await chmod(paths.bridgeDir, 0o700);
	await mkdir(paths.extensionDir, { recursive: true, mode: 0o700 });
	await chmod(paths.extensionDir, 0o700);

	const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

	const { privateKeyPem, publicKey } = await loadOrGenerateExtensionKey(paths.extensionKeyFile);
	const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
	const publicKeyBase64 = Buffer.from(publicKeyDer).toString("base64");
	const extensionId = computeExtensionIdFromKey(publicKeyDer);

	if (!existsSync(paths.extensionKeyFile)) {
		await writeFile(paths.extensionKeyFile, privateKeyPem, "utf8");
		await chmod(paths.extensionKeyFile, 0o600);
	}

	const extensionBackground = await readFile(join(packageRoot, "extension", "background.js"), "utf8");
	await writeFile(join(paths.extensionDir, "background.js"), extensionBackground, "utf8");

	const manifestTemplate = JSON.parse(
		await readFile(join(packageRoot, "extension", "manifest.template.json"), "utf8"),
	) as Record<string, unknown>;
	manifestTemplate.key = publicKeyBase64;
	await writeFile(join(paths.extensionDir, "manifest.json"), `${JSON.stringify(manifestTemplate, null, 2)}\n`, "utf8");

	const port = resolveBrowserBridgePort(env);
	const token = await loadOrGenerateToken(paths.configFile, port);
	const config = { port, token };
	await writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	await chmod(paths.configFile, 0o600);
	await writeFile(paths.extensionConfigFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	await chmod(paths.extensionConfigFile, 0o600);

	return {
		bridgeDir: paths.bridgeDir,
		extensionDir: paths.extensionDir,
		extensionId,
		configFile: paths.configFile,
		extensionConfigFile: paths.extensionConfigFile,
		port,
		tokenPreview: `${token.slice(0, 4)}…${token.slice(-4)}`,
	};
}

export function computeExtensionIdFromKey(spkiDer: Buffer): string {
	const digest = createHash("sha256").update(spkiDer).digest("hex").slice(0, 32);
	let id = "";
	for (const character of digest) {
		const nibble = Number.parseInt(character, 16);
		id += String.fromCharCode(nibble + "a".charCodeAt(0));
	}
	return id;
}

interface LoadedKeyPair {
	privateKeyPem: string;
	publicKey: KeyObject;
}

async function loadOrGenerateExtensionKey(keyFile: string): Promise<LoadedKeyPair> {
	if (existsSync(keyFile)) {
		const pem = await readFile(keyFile, "utf8");
		const privateKey = createPrivateKey(pem);
		const publicKey = createPublicKey(privateKey);
		return { privateKeyPem: pem, publicKey };
	}
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
	await mkdir(dirname(keyFile), { recursive: true });
	return { privateKeyPem: pem, publicKey };
}

async function loadOrGenerateToken(configFile: string, expectedPort: number): Promise<string> {
	if (existsSync(configFile)) {
		try {
			const raw = await readFile(configFile, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			if (
				parsed !== null &&
				typeof parsed === "object" &&
				typeof (parsed as { token?: unknown }).token === "string" &&
				(parsed as { token: string }).token.length >= 32 &&
				typeof (parsed as { port?: unknown }).port === "number" &&
				(parsed as { port: number }).port === expectedPort
			) {
				return (parsed as { token: string }).token;
			}
		} catch {
			// fall through and regenerate
		}
	}
	return randomBytes(32).toString("hex");
}

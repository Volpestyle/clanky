export const WORKFLOW_LOCAL_BASE_URL_ENV = "WORKFLOW_LOCAL_BASE_URL";
export const PORT_ENV = "PORT";

export function buildEveDevServerEnv(baseEnv: NodeJS.ProcessEnv, host: string, port: number): NodeJS.ProcessEnv {
	const configuredBaseUrl = baseEnv[WORKFLOW_LOCAL_BASE_URL_ENV]?.trim();
	return {
		...baseEnv,
		[PORT_ENV]: String(port),
		[WORKFLOW_LOCAL_BASE_URL_ENV]: configuredBaseUrl && configuredBaseUrl.length > 0 ? configuredBaseUrl : host,
	};
}

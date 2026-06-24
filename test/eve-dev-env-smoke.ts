import { buildEveDevServerEnv, PORT_ENV, WORKFLOW_LOCAL_BASE_URL_ENV } from "../agent/lib/eve-dev-env.ts";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const defaults = buildEveDevServerEnv({ EXISTING: "1" }, "http://127.0.0.1:2000", 2000);
assert(defaults.EXISTING === "1", "existing env entries should be preserved");
assert(defaults[PORT_ENV] === "2000", "PORT should match the Clanky Eve port");
assert(defaults[WORKFLOW_LOCAL_BASE_URL_ENV] === "http://127.0.0.1:2000", "workflow base URL should default to Clanky's Eve host");

const tunneled = buildEveDevServerEnv(
	{ [WORKFLOW_LOCAL_BASE_URL_ENV]: "https://clanky.example.test" },
	"http://127.0.0.1:2000",
	2000,
);
assert(tunneled[PORT_ENV] === "2000", "PORT should still match the Clanky Eve port when a tunnel is configured");
assert(tunneled[WORKFLOW_LOCAL_BASE_URL_ENV] === "https://clanky.example.test", "explicit workflow base URL should be respected");

console.log("ALL OK");

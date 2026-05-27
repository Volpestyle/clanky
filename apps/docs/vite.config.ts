import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: process.env.DOCS_BASE_PATH ?? "/",
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
		dedupe: ["react", "react-dom"],
	},
	optimizeDeps: {
		exclude: ["@volpestyle/night-compiler"],
	},
	server: {
		fs: {
			allow: ["../..", "../../../docs/packages/night-compiler"],
		},
	},
});

import { DocsApp } from "@volpestyle/night-compiler";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@volpestyle/night-compiler/styles.css";

import docsConfig from "./content";

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<DocsApp config={docsConfig} />
	</StrictMode>,
);

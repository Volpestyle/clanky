import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

// Clanky does host work through typed tools, the Seatbelt-sandboxed
// host_command context lane (ADR-0003), and visible Herdr panes. Keep Eve's
// built-in shell/file sandbox lightweight and dependency-only for local start.
export default defineSandbox({
	backend: justbash(),
});

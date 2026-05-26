import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	CURSOR_MARKER,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";

/**
 * Input variant that renders bullets instead of the typed characters.
 *
 * Pi's TUI does not ship a masked input, so we reuse its `Input` (paste
 * handling, cursor movement, kill ring all work) and only override the
 * visible render layer.
 */
class MaskedInput extends Input {
	render(width: number): string[] {
		const prompt = "> ";
		const available = Math.max(0, width - prompt.length);
		const length = this.getValue().length;
		const masked = "•".repeat(length);
		const focused = this.focused ? CURSOR_MARKER : "";
		const cursor = "\x1b[7m \x1b[27m";
		const visible = masked.slice(-Math.max(0, available - 1));
		const padding = " ".repeat(Math.max(0, available - visible.length - 1));
		return [`${prompt}${visible}${focused}${cursor}${padding}`];
	}
}

interface MaskedPromptOptions {
	title: string;
	subtitle?: string;
}

/**
 * Render a masked input via `ui.custom` and resolve with the typed value
 * (or `undefined` on cancel/escape). Bypasses Pi's stock `ExtensionInput`
 * because that component echoes characters in plaintext.
 */
export function promptForSecret(ui: ExtensionUIContext, options: MaskedPromptOptions): Promise<string | undefined> {
	return ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
		const container = new MaskedSecretComponent(tui, options.title, options.subtitle, done);
		return container;
	});
}

class MaskedSecretComponent extends Container implements Focusable {
	private readonly input: MaskedInput;
	private _focused = false;

	constructor(tui: TUI, title: string, subtitle: string | undefined, done: (value: string | undefined) => void) {
		super();
		this.input = new MaskedInput();
		this.input.onSubmit = () => done(this.input.getValue());
		this.input.onEscape = () => done(undefined);

		this.addChild(new Text(title, 1, 0));
		if (subtitle !== undefined && subtitle.length > 0) {
			this.addChild(new Text(subtitle, 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text("Enter to submit, Esc to cancel. Input is masked.", 1, 0));

		void tui;
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.input.onEscape?.();
			return;
		}
		this.input.handleInput(data);
	}
}

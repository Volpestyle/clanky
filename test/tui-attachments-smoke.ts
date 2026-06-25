import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildTuiAttachmentMessage,
	createDroppedPathPasteRewriter,
	parseTuiAttachmentPrompt,
	rewriteDroppedPathsToDirectives,
	TUI_ATTACHMENT_HELP,
} from "../agent/lib/tui-attachments.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const dir = join(tmpdir(), `clanky-tui-attachments-${process.pid}`);
await rm(dir, { force: true, recursive: true });
await mkdir(dir, { recursive: true });

try {
	const png = Buffer.alloc(24);
	Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
	const imagePath = join(dir, "screen shot.png");
	const notesPath = join(dir, "notes.md");
	await writeFile(imagePath, png);
	await writeFile(notesPath, "# Notes\n\nhello\n");

	const parsed = parseTuiAttachmentPrompt(`@image "${imagePath}"\nWhat changed?\n@file ${pathToFileURL(notesPath).href}`);
	assert(parsed.text === "What changed?", "parser did not remove attachment lines");
	assert(parsed.directives.length === 2, "parser did not preserve directives");
	assert(parsed.directives[0]?.kind === "image", "parser did not preserve image directive kind");

	const unchanged = await buildTuiAttachmentMessage("plain prompt", { cwd: dir });
	assert(unchanged === "plain prompt", "plain prompt should stay a string");

	const payload = await buildTuiAttachmentMessage(`@image "${imagePath}"\nWhat changed?`, { cwd: dir });
	assert(Array.isArray(payload), "attachment prompt should become UserContent");
	assert(payload[0]?.type === "text" && payload[0].text === "What changed?", "payload should keep cleaned text first");
	const file = payload.find((part) => part.type === "file");
	assert(file !== undefined, "payload should include a file part");
	assert(file.mediaType === "image/png", "payload should detect image media type");
	assert(typeof file.data === "string" && file.data.startsWith("data:image/png;base64,"), "payload should use a data URL");

	const defaultTextPayload = await buildTuiAttachmentMessage(`@file ${notesPath}`, { cwd: dir });
	assert(Array.isArray(defaultTextPayload), "file-only prompt should become UserContent");
	assert(defaultTextPayload[0]?.type === "text" && defaultTextPayload[0].text.length > 0, "file-only prompt should get default text");

	let rejected = false;
	try {
		await buildTuiAttachmentMessage(`@image ${notesPath}`, { cwd: dir });
	} catch {
		rejected = true;
	}
	assert(rejected, "@image should reject non-image attachments");
	assert(TUI_ATTACHMENT_HELP.includes("@image"), "help should mention image syntax");
	assert(/drag/iu.test(TUI_ATTACHMENT_HELP), "help should mention drag-and-drop");

	// Drag-and-drop directive rewriting.
	const escapedImagePath = imagePath.replace(/ /gu, "\\ ");
	const droppedImage = rewriteDroppedPathsToDirectives(escapedImagePath, { cwd: dir });
	assert(droppedImage === `\n@image ${imagePath}\n`, `escaped image drop should become an @image line, got ${JSON.stringify(droppedImage)}`);

	const droppedQuoted = rewriteDroppedPathsToDirectives(`"${imagePath}"`, { cwd: dir });
	assert(droppedQuoted === `\n@image ${imagePath}\n`, "quoted image drop should become an @image line");

	const droppedUrl = rewriteDroppedPathsToDirectives(pathToFileURL(imagePath).href, { cwd: dir });
	assert(droppedUrl === `\n@image ${imagePath}\n`, "file:// image drop should become an @image line");

	const droppedFile = rewriteDroppedPathsToDirectives(notesPath, { cwd: dir });
	assert(droppedFile === `\n@file ${notesPath}\n`, "non-image drop should become an @file line");

	const droppedMulti = rewriteDroppedPathsToDirectives(`"${imagePath}" ${notesPath}`, { cwd: dir });
	assert(droppedMulti === `\n@image ${imagePath}\n@file ${notesPath}\n`, "multi-file drop should produce one directive per file");

	assert(rewriteDroppedPathsToDirectives("just some pasted prose", { cwd: dir }) === null, "prose paste should not be rewritten");
	assert(rewriteDroppedPathsToDirectives(`${imagePath}\nsecond line`, { cwd: dir }) === null, "multi-line paste should not be rewritten");
	assert(rewriteDroppedPathsToDirectives("/does/not/exist.png", { cwd: dir }) === null, "missing-file drop should not be rewritten");

	// Bracketed-paste stream rewriter.
	const rewrite = createDroppedPathPasteRewriter({ cwd: dir });
	const wrapped = rewrite(`${PASTE_START}${escapedImagePath}${PASTE_END}`);
	assert(wrapped === `${PASTE_START}\n@image ${imagePath}\n${PASTE_END}`, `stream rewriter should rewrite a complete paste, got ${JSON.stringify(wrapped)}`);

	const passthrough = rewrite("plain keystrokes");
	assert(passthrough === "plain keystrokes", "non-paste input should pass through untouched");

	const prosePaste = rewrite(`${PASTE_START}hello world${PASTE_END}`);
	assert(prosePaste === `${PASTE_START}hello world${PASTE_END}`, "prose paste should pass through untouched");

	// Paste split across stdin chunks should buffer until the end marker arrives.
	const split = createDroppedPathPasteRewriter({ cwd: dir });
	const first = split(`before ${PASTE_START}${escapedImagePath.slice(0, 4)}`);
	assert(first === "before ", "leading text before a partial paste should flush immediately");
	const second = split(`${escapedImagePath.slice(4)}${PASTE_END}after`);
	assert(second === `${PASTE_START}\n@image ${imagePath}\n${PASTE_END}after`, `completed split paste should rewrite and forward trailing text, got ${JSON.stringify(second)}`);
} finally {
	await rm(dir, { force: true, recursive: true });
}

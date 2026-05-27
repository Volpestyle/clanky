import type { Token, Tokens } from "marked";
import mermaid from "mermaid";
import { type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

import { type Doc, docsBySource } from "@/content";
import { createSlugger, parseMarkdown } from "@/markdown";

let mermaidRenderSerial = 0;

const MERMAID_FONT_FAMILY = "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";

function readMermaidTheme(): "default" | "dark" {
	if (typeof document === "undefined") return "default";
	return document.documentElement.classList.contains("dark") ? "dark" : "default";
}

type MarkdownViewProps = {
	currentDoc: Doc;
	markdown: string;
	onNavigate: (slug: string, headingId?: string) => void;
};

type RenderContext = {
	currentDoc: Doc;
	onNavigate: (slug: string, headingId?: string) => void;
	slugForHeading: (value: string) => string;
};

export function MarkdownView({ currentDoc, markdown, onNavigate }: MarkdownViewProps) {
	const tokens = parseMarkdown(markdown);
	const slugForHeading = createSlugger();

	return (
		<section className="docs-prose">
			{tokens.map((token, index) =>
				renderBlockToken(token, `${token.type}-${index}`, {
					currentDoc,
					onNavigate,
					slugForHeading,
				}),
			)}
		</section>
	);
}

function renderBlockTokens(tokens: Token[], keyPrefix: string, context: RenderContext) {
	return tokens.map((token, index) => renderBlockToken(token, `${keyPrefix}-${token.type}-${index}`, context));
}

function renderBlockToken(token: Token, key: string, context: RenderContext): ReactNode {
	switch (token.type) {
		case "space":
			return null;
		case "heading": {
			const heading = token as Tokens.Heading;
			const id = context.slugForHeading(heading.text);
			const children = renderInlineTokens(heading.tokens, `${key}-inline`, context);
			return renderHeading(heading.depth, id, key, children);
		}
		case "paragraph": {
			const paragraph = token as Tokens.Paragraph;
			return <p key={key}>{renderInlineTokens(paragraph.tokens, `${key}-inline`, context)}</p>;
		}
		case "code": {
			const code = token as Tokens.Code;
			if (code.lang?.trim().toLowerCase() === "mermaid") {
				return <MermaidDiagram key={key} source={code.text} />;
			}

			return (
				<pre key={key}>
					<code>{code.text}</code>
				</pre>
			);
		}
		case "blockquote": {
			const blockquote = token as Tokens.Blockquote;
			return <blockquote key={key}>{renderBlockTokens(blockquote.tokens, `${key}-quote`, context)}</blockquote>;
		}
		case "list": {
			const list = token as Tokens.List;
			const items = list.items.map((item) => (
				<li key={`${key}-item-${item.raw}`}>{renderBlockTokens(item.tokens, `${key}-item-${item.raw}`, context)}</li>
			));
			return list.ordered ? (
				<ol key={key} start={typeof list.start === "number" ? list.start : undefined}>
					{items}
				</ol>
			) : (
				<ul key={key}>{items}</ul>
			);
		}
		case "hr":
			return <hr key={key} />;
		case "table": {
			const table = token as Tokens.Table;
			return (
				<table key={key}>
					<thead>
						<tr>
							{table.header.map((cell) => (
								<th align={cell.align ?? undefined} key={`${key}-header-${cell.text}`}>
									{renderInlineTokens(cell.tokens, `${key}-header-${cell.text}`, context)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{table.rows.map((row) => {
							const rowKey = row.map((cell) => cell.text).join("|");
							return (
								<tr key={`${key}-row-${rowKey}`}>
									{row.map((cell) => (
										<td align={cell.align ?? undefined} key={`${key}-cell-${rowKey}-${cell.text}`}>
											{renderInlineTokens(cell.tokens, `${key}-cell-${rowKey}-${cell.text}`, context)}
										</td>
									))}
								</tr>
							);
						})}
					</tbody>
				</table>
			);
		}
		case "html": {
			const html = token as Tokens.HTML;
			return html.text.trim() ? <p key={key}>{html.text}</p> : null;
		}
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens ? (
				<p key={key}>{renderInlineTokens(text.tokens, `${key}-inline`, context)}</p>
			) : (
				<p key={key}>{text.text}</p>
			);
		}
		default:
			return null;
	}
}

function renderInlineTokens(tokens: Token[], keyPrefix: string, context: RenderContext): ReactNode {
	return tokens.map((token, index) => renderInlineToken(token, `${keyPrefix}-${token.type}-${index}`, context));
}

function renderInlineToken(token: Token, key: string, context: RenderContext): ReactNode {
	switch (token.type) {
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens ? renderInlineTokens(text.tokens, key, context) : text.text;
		}
		case "escape": {
			const escaped = token as Tokens.Escape;
			return escaped.text;
		}
		case "codespan": {
			const codespan = token as Tokens.Codespan;
			return <code key={key}>{codespan.text}</code>;
		}
		case "strong": {
			const strong = token as Tokens.Strong;
			return <strong key={key}>{renderInlineTokens(strong.tokens, key, context)}</strong>;
		}
		case "em": {
			const em = token as Tokens.Em;
			return <em key={key}>{renderInlineTokens(em.tokens, key, context)}</em>;
		}
		case "del": {
			const del = token as Tokens.Del;
			return <del key={key}>{renderInlineTokens(del.tokens, key, context)}</del>;
		}
		case "link": {
			const link = token as Tokens.Link;
			return (
				<MarkdownLink href={link.href} key={key} title={link.title ?? undefined} context={context}>
					{renderInlineTokens(link.tokens, key, context)}
				</MarkdownLink>
			);
		}
		case "image": {
			const image = token as Tokens.Image;
			return <img alt={image.text} key={key} src={image.href} title={image.title ?? undefined} />;
		}
		case "br":
			return <br key={key} />;
		case "html": {
			const html = token as Tokens.HTML;
			return html.text;
		}
		default:
			return null;
	}
}

type MermaidDiagramProps = {
	source: string;
};

function MermaidDiagram({ source }: MermaidDiagramProps) {
	const containerRef = useRef<HTMLElement | null>(null);
	const generatedId = useId();
	const [theme, setTheme] = useState<"default" | "dark">(readMermaidTheme);

	useEffect(() => {
		const html = document.documentElement;
		const observer = new MutationObserver(() => setTheme(readMermaidTheme()));
		observer.observe(html, { attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		const target = container;

		if (!source.trim()) {
			target.dataset.docsMermaid = "error";
			return;
		}

		let cancelled = false;
		mermaidRenderSerial += 1;
		const safeId = generatedId.replace(/[^a-zA-Z0-9_-]/g, "-");
		const renderId = `docs-mermaid-${safeId}-${mermaidRenderSerial}`;

		async function renderDiagram() {
			try {
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					theme,
					fontFamily: MERMAID_FONT_FAMILY,
				});
				const { svg, bindFunctions } = await mermaid.render(renderId, source);
				if (cancelled) {
					return;
				}

				target.innerHTML = svg;
				target.dataset.docsMermaid = "rendered";
				bindFunctions?.(target);
			} catch (error) {
				if (cancelled) {
					return;
				}

				const message = error instanceof Error ? error.message : "Unable to render diagram.";
				const title = document.createElement("p");
				title.className = "docs-mermaid-error-title";
				title.textContent = "Diagram failed to render";

				const detail = document.createElement("p");
				detail.className = "docs-mermaid-error-detail";
				detail.textContent = message;

				const pre = document.createElement("pre");
				const code = document.createElement("code");
				code.textContent = source;
				pre.append(code);

				target.replaceChildren(title, detail, pre);
				target.dataset.docsMermaid = "error";
			}
		}

		void renderDiagram();

		return () => {
			cancelled = true;
		};
	}, [generatedId, source, theme]);

	return (
		<figure className="docs-mermaid" data-docs-mermaid="pending" ref={containerRef}>
			<pre>
				<code>{source}</code>
			</pre>
		</figure>
	);
}

type MarkdownLinkProps = {
	children: ReactNode;
	context: RenderContext;
	href: string;
	title?: string | undefined;
};

function MarkdownLink({ children, context, href, title }: MarkdownLinkProps) {
	const resolved = resolveLocalDocHref(context.currentDoc, href);
	const linkHref = resolved ? `?doc=${resolved.slug}${resolved.headingId ? `#${resolved.headingId}` : ""}` : href;

	function handleClick(event: MouseEvent<HTMLAnchorElement>) {
		if (!resolved) {
			return;
		}

		event.preventDefault();
		context.onNavigate(resolved.slug, resolved.headingId);
	}

	return (
		<a href={linkHref} onClick={handleClick} title={title}>
			{children}
		</a>
	);
}

function renderHeading(depth: number, id: string, key: string, children: ReactNode) {
	const anchor = (
		<a className="heading-anchor" href={`#${id}`}>
			{children}
		</a>
	);

	switch (depth) {
		case 2:
			return (
				<h2 id={id} key={key}>
					{anchor}
				</h2>
			);
		case 3:
			return (
				<h3 id={id} key={key}>
					{anchor}
				</h3>
			);
		case 4:
			return (
				<h4 id={id} key={key}>
					{anchor}
				</h4>
			);
		case 5:
			return (
				<h5 id={id} key={key}>
					{anchor}
				</h5>
			);
		case 6:
			return (
				<h6 id={id} key={key}>
					{anchor}
				</h6>
			);
		default:
			return (
				<h2 id={id} key={key}>
					{anchor}
				</h2>
			);
	}
}

function resolveLocalDocHref(currentDoc: Doc, href: string) {
	if (href.startsWith("http:") || href.startsWith("https:") || href.startsWith("mailto:")) {
		return undefined;
	}

	const [rawPath = "", rawHash] = href.split("#");
	const headingId = rawHash ? decodeURIComponent(rawHash) : undefined;

	if (rawPath === "") {
		return headingId ? { slug: currentDoc.slug, headingId } : undefined;
	}

	const sourceDir = currentDoc.source.includes("/") ? `${currentDoc.source.split("/").slice(0, -1).join("/")}/` : "";
	const candidates = [rawPath, `${sourceDir}${rawPath}`].map(normalizeDocPath);
	const doc = candidates.map((candidate) => docsBySource.get(candidate.toLowerCase())).find(Boolean);

	return doc ? { slug: doc.slug, headingId } : undefined;
}

function normalizeDocPath(value: string) {
	const decoded = decodeURIComponent(value).replace(/^\.\//, "");
	const segments: string[] = [];

	for (const segment of decoded.split("/")) {
		if (!segment || segment === ".") {
			continue;
		}

		if (segment === "..") {
			segments.pop();
			continue;
		}

		segments.push(segment);
	}

	return segments.join("/");
}

import {
	ArrowRightIcon,
	BookOpenTextIcon,
	CheckIcon,
	CornerDownLeftIcon,
	FileTextIcon,
	HashIcon,
	HistoryIcon,
	SearchIcon,
	ShieldCheckIcon,
	SparklesIcon,
	TerminalSquareIcon,
	XIcon,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { cn } from "./lib/utils";
import { type DocsSearch, highlightSegments, type MatchRange, type SearchMatch } from "./search";
import type { Doc, DocsSiteConfig } from "./types";

const RECENTS_LIMIT = 6;

type SearchPaletteProps = {
	config: DocsSiteConfig;
	docsBySlug: Map<string, Doc>;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onNavigate: (slug: string, headingId?: string) => void;
	search: DocsSearch;
};

export function SearchPalette({ config, docsBySlug, open, onOpenChange, onNavigate, search }: SearchPaletteProps) {
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const recentsKey = `${config.site.id}:recent-searches`;
	const [recents, setRecents] = useState<string[]>(() => loadRecents(recentsKey));
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const listboxId = useId();

	const trimmedQuery = query.trim();
	const updateQuery = useCallback((value: string) => {
		setQuery(value);
		setActiveIndex(0);
	}, []);
	const matches = useMemo(() => (trimmedQuery ? search(trimmedQuery, 40) : []), [search, trimmedQuery]);

	const groupedMatches = useMemo(() => groupMatchesByDoc(matches, docsBySlug), [docsBySlug, matches]);

	const flatItems = useMemo<PaletteItem[]>(() => {
		if (trimmedQuery) {
			return flattenGrouped(groupedMatches);
		}
		return buildIdleItems(recents, config.docs);
	}, [config.docs, groupedMatches, recents, trimmedQuery]);

	useEffect(() => {
		if (!open) {
			setQuery("");
			setActiveIndex(0);
		}
	}, [open]);

	useLayoutEffect(() => {
		if (!open) {
			return;
		}
		const id = window.requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		});
		return () => window.cancelAnimationFrame(id);
	}, [open]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const element = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${activeIndex}"]`);
		element?.scrollIntoView({ block: "nearest" });
	}, [activeIndex, open]);

	const commit = useCallback(
		(item: PaletteItem) => {
			if (item.kind === "result") {
				rememberQuery(recentsKey, trimmedQuery);
				setRecents(loadRecents(recentsKey));
				onNavigate(item.match.section.docSlug, item.match.section.headingId ?? undefined);
				onOpenChange(false);
				return;
			}
			if (item.kind === "doc") {
				rememberQuery(recentsKey, item.doc.title);
				setRecents(loadRecents(recentsKey));
				onNavigate(item.doc.slug);
				onOpenChange(false);
				return;
			}
			if (item.kind === "recent") {
				updateQuery(item.value);
			}
		},
		[onNavigate, onOpenChange, recentsKey, trimmedQuery, updateQuery],
	);

	function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "ArrowDown") {
			if (flatItems.length === 0) {
				return;
			}
			event.preventDefault();
			setActiveIndex((prev) => (prev + 1) % flatItems.length);
			return;
		}
		if (event.key === "ArrowUp") {
			if (flatItems.length === 0) {
				return;
			}
			event.preventDefault();
			setActiveIndex((prev) => (prev - 1 + flatItems.length) % flatItems.length);
			return;
		}
		if (event.key === "Enter") {
			const item = flatItems[activeIndex];
			if (!item) return;
			event.preventDefault();
			commit(item);
			return;
		}
		if (event.key === "Home") {
			event.preventDefault();
			setActiveIndex(0);
			return;
		}
		if (event.key === "End") {
			event.preventDefault();
			setActiveIndex(Math.max(0, flatItems.length - 1));
		}
	}

	const activeItemId = flatItems[activeIndex] ? `${listboxId}-item-${activeIndex}` : undefined;

	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/40 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
				<DialogPrimitive.Content
					aria-describedby={undefined}
					className="fixed top-[8vh] left-1/2 z-50 flex max-h-[80vh] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
				>
					<DialogPrimitive.Title className="sr-only">Search documentation</DialogPrimitive.Title>

					<div className="flex items-center gap-3 border-b px-4">
						<SearchIcon className="size-4 shrink-0 text-muted-foreground" />
						<input
							ref={inputRef}
							value={query}
							onChange={(event) => updateQuery(event.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Search docs, sections, snippets…"
							aria-label="Search docs"
							aria-controls={listboxId}
							aria-activedescendant={activeItemId}
							aria-autocomplete="list"
							autoComplete="off"
							spellCheck={false}
							className="h-12 w-full min-w-0 bg-transparent text-sm placeholder:text-muted-foreground/80 focus:outline-none"
						/>
						{trimmedQuery && (
							<button
								type="button"
								onClick={() => updateQuery("")}
								className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
								aria-label="Clear search"
							>
								<XIcon className="size-3.5" />
							</button>
						)}
						<KeyHint label="Esc" className="hidden sm:inline-flex" />
					</div>

					<div ref={listRef} id={listboxId} role="listbox" className="min-h-0 flex-1 overflow-y-auto">
						{trimmedQuery ? (
							<ResultsView
								listboxId={listboxId}
								groupedMatches={groupedMatches}
								flatItems={flatItems}
								activeIndex={activeIndex}
								onHover={setActiveIndex}
								onCommit={commit}
								query={trimmedQuery}
							/>
						) : (
							<IdleView
								listboxId={listboxId}
								items={flatItems}
								activeIndex={activeIndex}
								onHover={setActiveIndex}
								onCommit={commit}
								onClearRecents={() => {
									clearRecents(recentsKey);
									setRecents([]);
								}}
								hasRecents={recents.length > 0}
							/>
						)}
					</div>

					<footer className="flex items-center justify-between gap-3 border-t bg-muted/40 px-3 py-2 text-muted-foreground text-xs">
						<div className="flex items-center gap-3">
							<span className="inline-flex items-center gap-1.5">
								<KeyHint label="↑" />
								<KeyHint label="↓" />
								<span>navigate</span>
							</span>
							<span className="inline-flex items-center gap-1.5">
								<KeyHint label="↵" />
								<span>open</span>
							</span>
							<span className="hidden items-center gap-1.5 sm:inline-flex">
								<KeyHint label="Esc" />
								<span>close</span>
							</span>
						</div>
						{trimmedQuery ? (
							<span>{matches.length} results</span>
						) : (
							<span>Tip: press {isAppleLike() ? "⌘K" : "Ctrl+K"} anywhere</span>
						)}
					</footer>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

type ResultsViewProps = {
	listboxId: string;
	groupedMatches: GroupedMatch[];
	flatItems: PaletteItem[];
	activeIndex: number;
	onHover: (index: number) => void;
	onCommit: (item: PaletteItem) => void;
	query: string;
};

function ResultsView({
	listboxId,
	groupedMatches,
	flatItems,
	activeIndex,
	onHover,
	onCommit,
	query,
}: ResultsViewProps) {
	if (groupedMatches.length === 0) {
		return (
			<div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
				<SearchIcon className="size-6 text-muted-foreground" />
				<div>
					<p className="font-medium text-sm">No matches for "{query}"</p>
					<p className="mt-1 text-muted-foreground text-xs">
						Try a shorter or different term — search covers titles, headings, and body text.
					</p>
				</div>
			</div>
		);
	}

	const indexMap = new Map(flatItems.map((item, index) => [item.key, index]));

	return (
		<div className="flex flex-col py-1">
			{groupedMatches.map((group) => {
				const Icon = iconForGroup(group.doc.group);
				return (
					<section key={group.doc.slug} className="px-2 py-1">
						<header className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
							<div className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wider">
								<Icon className="size-3.5" />
								{group.doc.title}
							</div>
							<span className="text-muted-foreground text-[10px]">{group.matches.length}</span>
						</header>

						<div className="flex flex-col gap-0.5">
							{group.matches.map((match) => {
								const item: PaletteItem = {
									kind: "result",
									key: `${match.section.docSlug}#${match.section.headingId ?? "doc"}`,
									match,
								};
								const index = indexMap.get(item.key) ?? -1;
								const active = index === activeIndex;
								return (
									<ResultRow
										key={item.key}
										id={`${listboxId}-item-${index}`}
										index={index}
										active={active}
										match={match}
										onHover={onHover}
										onSelect={() => onCommit(item)}
									/>
								);
							})}
						</div>
					</section>
				);
			})}
		</div>
	);
}

type IdleViewProps = {
	listboxId: string;
	items: PaletteItem[];
	activeIndex: number;
	onHover: (index: number) => void;
	onCommit: (item: PaletteItem) => void;
	onClearRecents: () => void;
	hasRecents: boolean;
};

function IdleView({ listboxId, items, activeIndex, onHover, onCommit, onClearRecents, hasRecents }: IdleViewProps) {
	const recentItems = items.filter((item) => item.kind === "recent");
	const docItems = items.filter((item) => item.kind === "doc");

	return (
		<div className="flex flex-col py-1">
			{hasRecents && (
				<section className="px-2 py-1">
					<header className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
						<div className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wider">
							<HistoryIcon className="size-3.5" />
							Recent
						</div>
						<button
							type="button"
							onClick={onClearRecents}
							className="text-[10px] text-muted-foreground hover:text-foreground"
						>
							Clear
						</button>
					</header>
					<div className="flex flex-col gap-0.5">
						{recentItems.map((item) => {
							const index = items.indexOf(item);
							return (
								<button
									type="button"
									key={`recent-${item.value}`}
									id={`${listboxId}-item-${index}`}
									data-palette-index={index}
									role="option"
									aria-selected={index === activeIndex}
									onMouseEnter={() => onHover(index)}
									onClick={() => onCommit(item)}
									className={cn(
										"flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
										index === activeIndex
											? "bg-accent text-accent-foreground"
											: "text-muted-foreground hover:bg-accent/60",
									)}
								>
									<HistoryIcon className="size-3.5 shrink-0" />
									<span className="min-w-0 flex-1 truncate">{item.value}</span>
									<ArrowRightIcon className="size-3 shrink-0 opacity-60" />
								</button>
							);
						})}
					</div>
				</section>
			)}

			<section className="px-2 py-1">
				<header className="flex items-center gap-1.5 px-3 pt-2 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">
					<BookOpenTextIcon className="size-3.5" />
					All docs
				</header>
				<div className="flex flex-col gap-0.5">
					{docItems.map((item) => {
						if (item.kind !== "doc") return null;
						const Icon = iconForGroup(item.doc.group);
						const index = items.indexOf(item);
						return (
							<button
								type="button"
								key={`doc-${item.doc.slug}`}
								id={`${listboxId}-item-${index}`}
								data-palette-index={index}
								role="option"
								aria-selected={index === activeIndex}
								onMouseEnter={() => onHover(index)}
								onClick={() => onCommit(item)}
								className={cn(
									"flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
									index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
								)}
							>
								<Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="truncate font-medium">{item.doc.title}</span>
									<span className="truncate text-muted-foreground text-xs">{item.doc.description}</span>
								</span>
							</button>
						);
					})}
				</div>
			</section>
		</div>
	);
}

type ResultRowProps = {
	id: string;
	index: number;
	active: boolean;
	match: SearchMatch;
	onHover: (index: number) => void;
	onSelect: () => void;
};

function ResultRow({ id, index, active, match, onHover, onSelect }: ResultRowProps) {
	const section = match.section;
	const isDocLevel = section.headingId === null;
	const headingLabel = section.headingPath.slice(1).join(" › ");

	return (
		<button
			type="button"
			id={id}
			data-palette-index={index}
			role="option"
			aria-selected={active}
			onMouseEnter={() => onHover(index)}
			onClick={onSelect}
			className={cn(
				"group flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
				active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
			)}
		>
			<span
				className={cn(
					"mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground",
					active && "border-foreground/20 text-foreground",
				)}
			>
				{isDocLevel ? <FileTextIcon className="size-3.5" /> : <HashIcon className="size-3.5" />}
			</span>

			<span className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="flex flex-wrap items-baseline gap-x-2">
					<span className="truncate font-medium text-sm">
						{isDocLevel ? (
							<HighlightedText text={section.docTitle} ranges={match.titleRanges} />
						) : (
							<HighlightedText
								text={headingLabel || section.docTitle}
								ranges={offsetRanges(match.headingRanges, section.docTitle.length + 3)}
							/>
						)}
					</span>
					{!isDocLevel && <span className="text-muted-foreground text-xs">in {section.docTitle}</span>}
				</span>
				{match.snippet && (
					<span className="line-clamp-2 text-muted-foreground text-xs leading-5">
						<HighlightedText text={match.snippet} ranges={match.snippetRanges} />
					</span>
				)}
			</span>

			<CornerDownLeftIcon
				className={cn(
					"mt-1.5 size-3.5 shrink-0 transition-opacity",
					active ? "opacity-100" : "opacity-0 group-hover:opacity-60",
				)}
			/>
		</button>
	);
}

type HighlightedTextProps = {
	text: string;
	ranges: MatchRange[];
};

function HighlightedText({ text, ranges }: HighlightedTextProps): ReactNode {
	const segments = highlightSegments(text, ranges);
	return segments.map((segment, index) =>
		segment.highlight ? (
			<mark key={`${index}-${segment.text}`} className="rounded-sm bg-foreground/15 px-0.5 text-foreground">
				{segment.text}
			</mark>
		) : (
			<span key={`${index}-${segment.text}`}>{segment.text}</span>
		),
	);
}

type KeyHintProps = {
	label: string;
	className?: string;
};

function KeyHint({ label, className }: KeyHintProps) {
	return (
		<kbd
			className={cn(
				"inline-flex h-5 min-w-5 items-center justify-center rounded border bg-background px-1 font-medium font-sans text-[10px] text-muted-foreground shadow-xs",
				className,
			)}
		>
			{label}
		</kbd>
	);
}

type PaletteItem =
	| { kind: "result"; key: string; match: SearchMatch }
	| { kind: "doc"; key: string; doc: Doc }
	| { kind: "recent"; key: string; value: string };

type GroupedMatch = {
	doc: Doc;
	matches: SearchMatch[];
};

function groupMatchesByDoc(matches: SearchMatch[], docsBySlug: Map<string, Doc>): GroupedMatch[] {
	const order: string[] = [];
	const byDoc = new Map<string, SearchMatch[]>();

	for (const match of matches) {
		const slug = match.section.docSlug;
		if (!byDoc.has(slug)) {
			byDoc.set(slug, []);
			order.push(slug);
		}
		byDoc.get(slug)?.push(match);
	}

	return order
		.map((slug) => {
			const doc = docsBySlug.get(slug);
			const list = byDoc.get(slug);
			if (!doc || !list) return null;
			return { doc, matches: list } satisfies GroupedMatch;
		})
		.filter((value): value is GroupedMatch => value !== null);
}

function flattenGrouped(grouped: GroupedMatch[]): PaletteItem[] {
	const items: PaletteItem[] = [];
	for (const group of grouped) {
		for (const match of group.matches) {
			items.push({
				kind: "result",
				key: `${match.section.docSlug}#${match.section.headingId ?? "doc"}`,
				match,
			});
		}
	}
	return items;
}

function buildIdleItems(recents: string[], docs: readonly Doc[]): PaletteItem[] {
	const items: PaletteItem[] = [];
	for (const value of recents) {
		items.push({ kind: "recent", key: `recent:${value}`, value });
	}
	for (const doc of docs) {
		items.push({ kind: "doc", key: `doc:${doc.slug}`, doc });
	}
	return items;
}

function offsetRanges(ranges: MatchRange[], offset: number): MatchRange[] {
	return ranges.map((range) => ({ start: Math.max(0, range.start - offset), end: Math.max(0, range.end - offset) }));
}

function loadRecents(recentsKey: string): string[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(recentsKey);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((value): value is string => typeof value === "string").slice(0, RECENTS_LIMIT);
	} catch {
		return [];
	}
}

function rememberQuery(recentsKey: string, value: string) {
	if (typeof window === "undefined") return;
	const trimmed = value.trim();
	if (!trimmed) return;
	const existing = loadRecents(recentsKey).filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
	const next = [trimmed, ...existing].slice(0, RECENTS_LIMIT);
	try {
		window.localStorage.setItem(recentsKey, JSON.stringify(next));
	} catch {
		// ignore quota errors; recents are best-effort
	}
}

function clearRecents(recentsKey: string) {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.removeItem(recentsKey);
	} catch {
		// ignore
	}
}

function isAppleLike() {
	if (typeof navigator === "undefined") return true;
	return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

function iconForGroup(group: string) {
	const normalized = group.toLowerCase();
	if (normalized.includes("start") || normalized.includes("overview")) return BookOpenTextIcon;
	if (normalized.includes("setup") || normalized.includes("install")) return CheckIcon;
	if (normalized.includes("operation") || normalized.includes("runtime") || normalized.includes("runbook")) {
		return TerminalSquareIcon;
	}
	if (normalized.includes("advanced") || normalized.includes("architecture") || normalized.includes("security")) {
		return ShieldCheckIcon;
	}
	if (normalized.includes("maintainer") || normalized.includes("roadmap") || normalized.includes("archive")) {
		return SparklesIcon;
	}
	return FileTextIcon;
}

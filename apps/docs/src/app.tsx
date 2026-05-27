import {
	BookOpenTextIcon,
	CheckIcon,
	ClipboardIcon,
	FileTextIcon,
	MenuIcon,
	SearchIcon,
	ShieldCheckIcon,
	SparklesIcon,
	TerminalSquareIcon,
	XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { type Doc, type DocGroup, defaultDocSlug, docs, docsBySlug } from "@/content";
import { cn } from "@/lib/utils";
import { extractHeadings, type Heading, stripLeadingTitle } from "@/markdown";
import { MarkdownView } from "@/markdown-view";
import { search } from "@/search";
import { SearchPalette } from "@/search-palette";

const groups: DocGroup[] = ["Start", "Operations", "Planning", "Evidence"];

const groupIcons = {
	Start: BookOpenTextIcon,
	Operations: TerminalSquareIcon,
	Planning: SparklesIcon,
	Evidence: ShieldCheckIcon,
} satisfies Record<DocGroup, typeof BookOpenTextIcon>;

export function App() {
	const { slug, navigate } = useDocRouter();
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const [isPaletteOpen, setIsPaletteOpen] = useState(false);
	const [copied, setCopied] = useState(false);

	const activeDoc = getDocOrDefault(slug);
	const bodyMarkdown = useMemo(() => stripLeadingTitle(activeDoc.markdown), [activeDoc.markdown]);
	const headings = useMemo(() => extractHeadings(bodyMarkdown), [bodyMarkdown]);

	useEffect(() => {
		if (!isMenuOpen) {
			return;
		}

		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				setIsMenuOpen(false);
			}
		}

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isMenuOpen]);

	useEffect(() => {
		function handleKeyDown(event: KeyboardEvent) {
			if (event.defaultPrevented) {
				return;
			}

			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setIsPaletteOpen((prev) => !prev);
				return;
			}

			if (event.key === "/" && !isTypingInForm(event.target)) {
				event.preventDefault();
				setIsPaletteOpen(true);
			}
		}

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);

	const navigateAndClose = useCallback(
		(nextSlug: string, headingId?: string) => {
			setIsMenuOpen(false);
			navigate(nextSlug, headingId);
		},
		[navigate],
	);

	async function copyCurrentLink() {
		await navigator.clipboard.writeText(window.location.href);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1400);
	}

	return (
		<TooltipProvider>
			<div className="min-h-screen bg-background text-foreground">
				<header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
					<div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-3 px-4 lg:px-6">
						<Button
							className="lg:hidden"
							size="icon-sm"
							variant="ghost"
							aria-label="Open navigation"
							onClick={() => setIsMenuOpen(true)}
						>
							<MenuIcon data-icon="inline-start" />
						</Button>

						<a className="flex min-w-0 items-center gap-2 font-semibold text-[15px]" href="?doc=overview">
							<span className="size-5 rounded-full bg-primary" />
							<span className="truncate">Clanky Docs</span>
						</a>

						<div className="ml-auto hidden w-full max-w-sm items-center md:flex">
							<SearchTrigger onOpen={() => setIsPaletteOpen(true)} />
						</div>

						<Button
							className="md:hidden"
							size="icon-sm"
							variant="ghost"
							aria-label="Search docs"
							onClick={() => setIsPaletteOpen(true)}
						>
							<SearchIcon data-icon="inline-start" />
						</Button>

						<Badge variant="outline" className="hidden rounded-md font-medium sm:inline-flex">
							localhost
						</Badge>
					</div>
				</header>

				{isMenuOpen && (
					<MobileNavigation
						activeSlug={activeDoc.slug}
						onClose={() => setIsMenuOpen(false)}
						onNavigate={navigateAndClose}
						onOpenSearch={() => {
							setIsMenuOpen(false);
							setIsPaletteOpen(true);
						}}
					/>
				)}

				<div className="mx-auto grid w-full max-w-[1440px] grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,860px)_260px]">
					<aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] border-r lg:block">
						<Sidebar
							activeSlug={activeDoc.slug}
							onNavigate={navigateAndClose}
							onOpenSearch={() => setIsPaletteOpen(true)}
						/>
					</aside>

					<main className="min-w-0 border-r">
						<article className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-[860px] flex-col px-5 py-8 sm:px-8 lg:px-10">
							<div className="flex flex-col gap-4 border-b pb-8">
								<div className="flex flex-wrap items-center gap-2">
									<Badge variant="secondary" className="rounded-md">
										{activeDoc.group}
									</Badge>
									<Badge variant="outline" className="rounded-md font-normal text-muted-foreground">
										{activeDoc.source}
									</Badge>
								</div>

								<div className="flex flex-col gap-3">
									<h1 className="max-w-3xl font-bold text-4xl leading-tight md:text-5xl">{activeDoc.title}</h1>
									<p className="max-w-2xl text-muted-foreground text-sm leading-6 md:text-base">
										{activeDoc.description}
									</p>
								</div>

								<div className="flex flex-wrap items-center gap-2">
									<Tooltip>
										<TooltipTrigger asChild>
											<Button variant="outline" size="sm" onClick={copyCurrentLink}>
												{copied ? <CheckIcon data-icon="inline-start" /> : <ClipboardIcon data-icon="inline-start" />}
												{copied ? "Copied" : "Copy link"}
											</Button>
										</TooltipTrigger>
										<TooltipContent>Copy this page URL</TooltipContent>
									</Tooltip>
									<span className="text-muted-foreground text-xs">{headings.length} sections</span>
								</div>
							</div>

							<MarkdownView currentDoc={activeDoc} markdown={bodyMarkdown} onNavigate={navigate} />
						</article>
					</main>

					<aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] xl:block">
						<TableOfContents activeDoc={activeDoc} headings={headings} onNavigate={navigateAndClose} />
					</aside>
				</div>
			</div>

			<SearchPalette open={isPaletteOpen} onOpenChange={setIsPaletteOpen} onNavigate={navigateAndClose} />
		</TooltipProvider>
	);
}

type MobileNavigationProps = {
	activeSlug: string;
	onClose: () => void;
	onNavigate: (slug: string) => void;
	onOpenSearch: () => void;
};

function MobileNavigation({ activeSlug, onClose, onNavigate, onOpenSearch }: MobileNavigationProps) {
	return (
		<div className="fixed inset-0 z-50 lg:hidden">
			<button className="absolute inset-0 bg-black/50" type="button" aria-label="Close navigation" onClick={onClose} />
			<div
				aria-describedby="mobile-nav-description"
				aria-labelledby="mobile-nav-title"
				aria-modal="true"
				className="absolute inset-y-0 left-0 flex w-[320px] max-w-[85vw] flex-col border-r bg-background shadow-lg"
				role="dialog"
			>
				<div className="flex items-start justify-between gap-3 border-b p-4">
					<div className="flex flex-col gap-1">
						<h2 id="mobile-nav-title" className="font-semibold text-sm">
							Clanky Docs
						</h2>
						<p id="mobile-nav-description" className="sr-only">
							Documentation navigation
						</p>
					</div>
					<Button size="icon-sm" variant="ghost" aria-label="Close navigation" onClick={onClose}>
						<XIcon data-icon="inline-start" />
					</Button>
				</div>
				<Sidebar activeSlug={activeSlug} onNavigate={onNavigate} onOpenSearch={onOpenSearch} />
			</div>
		</div>
	);
}

type SidebarProps = {
	activeSlug: string;
	onNavigate: (slug: string) => void;
	onOpenSearch: () => void;
};

function Sidebar({ activeSlug, onNavigate, onOpenSearch }: SidebarProps) {
	const [filter, setFilter] = useState("");

	const filteredDocs = useMemo(() => filterDocsForSidebar(filter), [filter]);

	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-col gap-2 border-b p-4">
				<SearchTrigger onOpen={onOpenSearch} />
				<SidebarFilter value={filter} onChange={setFilter} />
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<nav className="flex flex-col gap-6 p-4">
					{groups.map((group) => {
						const Icon = groupIcons[group];
						const groupDocs = filteredDocs.filter((doc) => doc.group === group);
						if (groupDocs.length === 0) {
							return null;
						}

						return (
							<section className="flex flex-col gap-2" key={group}>
								<div className="flex items-center gap-2 px-2 font-medium text-muted-foreground text-xs uppercase">
									<Icon data-icon="inline-start" />
									{group}
								</div>
								<div className="flex flex-col gap-1">
									{groupDocs.map((doc) => (
										<Button
											key={doc.slug}
											type="button"
											variant={doc.slug === activeSlug ? "secondary" : "ghost"}
											className={cn(
												"h-auto justify-start whitespace-normal px-2 py-2 text-left font-medium text-sm leading-5",
												doc.slug !== activeSlug && "text-muted-foreground",
											)}
											onClick={() => onNavigate(doc.slug)}
										>
											<FileTextIcon data-icon="inline-start" />
											<span className="min-w-0 flex-1 truncate">{doc.title}</span>
										</Button>
									))}
								</div>
							</section>
						);
					})}

					{filter.trim() && filteredDocs.length === 0 && (
						<button
							type="button"
							onClick={onOpenSearch}
							className="rounded-md border border-dashed px-3 py-4 text-left text-muted-foreground text-xs hover:bg-accent hover:text-accent-foreground"
						>
							No docs match "{filter}". Try the full search →
						</button>
					)}
				</nav>
			</ScrollArea>
		</div>
	);
}

type SearchTriggerProps = {
	onOpen: () => void;
};

function SearchTrigger({ onOpen }: SearchTriggerProps) {
	return (
		<button
			type="button"
			onClick={onOpen}
			className="group flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-left text-muted-foreground text-sm shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
			aria-label="Search docs"
		>
			<SearchIcon className="size-4 shrink-0" />
			<span className="flex-1 truncate">Search docs…</span>
			<kbd className="ml-auto hidden h-5 items-center gap-0.5 rounded border bg-background px-1.5 font-medium font-sans text-[10px] text-muted-foreground sm:inline-flex">
				{isAppleLike() ? "⌘" : "Ctrl"}K
			</kbd>
		</button>
	);
}

type SidebarFilterProps = {
	value: string;
	onChange: (value: string) => void;
};

function SidebarFilter({ value, onChange }: SidebarFilterProps) {
	return (
		<div className="relative w-full">
			<input
				type="text"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				placeholder="Filter pages"
				aria-label="Filter sidebar pages"
				className="h-7 w-full rounded-md border border-input bg-transparent px-2 pr-6 text-xs placeholder:text-muted-foreground/70 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
			/>
			{value && (
				<button
					type="button"
					onClick={() => onChange("")}
					aria-label="Clear filter"
					className="absolute top-1/2 right-1 -translate-y-1/2 rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
				>
					<XIcon className="size-3" />
				</button>
			)}
		</div>
	);
}

type TableOfContentsProps = {
	activeDoc: Doc;
	headings: Heading[];
	onNavigate: (slug: string, headingId?: string) => void;
};

function TableOfContents({ activeDoc, headings, onNavigate }: TableOfContentsProps) {
	return (
		<div className="flex h-full flex-col gap-4 p-6">
			<div className="flex flex-col gap-1">
				<p className="font-medium text-sm">On this page</p>
				<p className="text-muted-foreground text-xs">{activeDoc.source}</p>
			</div>
			<Separator />
			<ScrollArea className="min-h-0 flex-1">
				<nav className="flex flex-col gap-1 pr-3">
					{headings.map((heading) => (
						<button
							key={heading.id}
							type="button"
							className={cn(
								"rounded-md px-2 py-1.5 text-left text-muted-foreground text-sm leading-5 hover:bg-accent hover:text-accent-foreground",
								heading.depth === 3 && "ml-3 text-xs",
							)}
							onClick={() => onNavigate(activeDoc.slug, heading.id)}
						>
							{heading.text}
						</button>
					))}
				</nav>
			</ScrollArea>
		</div>
	);
}

function useDocRouter() {
	const [slug, setSlug] = useState(getDocSlugFromLocation);

	useEffect(() => {
		function syncFromLocation() {
			setSlug(getDocSlugFromLocation());
		}

		window.addEventListener("popstate", syncFromLocation);
		return () => window.removeEventListener("popstate", syncFromLocation);
	}, []);

	const navigate = useCallback((nextSlug: string, headingId?: string) => {
		const nextDoc = getDocOrDefault(nextSlug);
		const url = new URL(window.location.href);
		url.searchParams.set("doc", nextDoc.slug);
		url.hash = headingId ? headingId : "";
		window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
		setSlug(nextDoc.slug);
		scrollAfterNavigation(headingId);
	}, []);

	return { slug, navigate };
}

function getDocSlugFromLocation() {
	const value = new URL(window.location.href).searchParams.get("doc");
	return value && docsBySlug.has(value) ? value : defaultDocSlug;
}

function getDocOrDefault(slug: string) {
	const doc = docsBySlug.get(slug) ?? docsBySlug.get(defaultDocSlug);
	if (!doc) {
		throw new Error("No documentation pages are registered.");
	}

	return doc;
}

function filterDocsForSidebar(query: string): Doc[] {
	const normalized = query.trim();
	if (!normalized) {
		return [...docs];
	}

	const matches = search(normalized, 200);
	if (matches.length === 0) {
		return [];
	}

	const matchedSlugs = new Set(matches.map((match) => match.section.docSlug));
	return docs.filter((doc) => matchedSlugs.has(doc.slug));
}

function scrollAfterNavigation(headingId?: string) {
	window.requestAnimationFrame(() => {
		window.requestAnimationFrame(() => {
			if (!headingId) {
				window.scrollTo({ top: 0, behavior: "smooth" });
				return;
			}

			document.getElementById(headingId)?.scrollIntoView({ block: "start", behavior: "smooth" });
		});
	});
}

function isTypingInForm(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	if (target.isContentEditable) {
		return true;
	}
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function isAppleLike() {
	if (typeof navigator === "undefined") return true;
	return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

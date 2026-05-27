import {
	BookOpenTextIcon,
	CheckIcon,
	ChevronDownIcon,
	ClipboardIcon,
	CornerDownRightIcon,
	FileTextIcon,
	MenuIcon,
	MoonIcon,
	SearchIcon,
	ShieldCheckIcon,
	SparklesIcon,
	SunIcon,
	TerminalSquareIcon,
	XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { ScrollArea } from "./components/ui/scroll-area";
import { Separator } from "./components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { docsBySlug as buildDocsBySlug, docsBySource as buildDocsBySource } from "./config";
import { cn } from "./lib/utils";
import { extractHeadings, type Heading, stripLeadingTitle } from "./markdown";
import { MarkdownView } from "./markdown-view";
import { createDocsSearch, type DocsSearch } from "./search";
import { SearchPalette } from "./search-palette";
import type { Doc, DocsSiteConfig, DocsSiteLink } from "./types";

function ProjectLogo({ config }: { config: DocsSiteConfig }) {
	if (!config.site.logo) {
		return <BookOpenTextIcon className="size-8 shrink-0 rounded-md border p-1.5" />;
	}

	return (
		<img
			src={assetUrl(config.site.logo.src)}
			srcSet={config.site.logo.srcSet ? assetSrcSet(config.site.logo.srcSet) : undefined}
			alt={config.site.logo.alt ?? ""}
			width={config.site.logo.width ?? 32}
			height={config.site.logo.height ?? 32}
			className="size-8 shrink-0 rounded-md"
		/>
	);
}

function useTheme(storageKey: string) {
	const [theme, setTheme] = useState<"light" | "dark">(() =>
		typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light",
	);
	const skipFirstWrite = useRef(true);

	useEffect(() => {
		if (skipFirstWrite.current) {
			skipFirstWrite.current = false;
			return;
		}

		document.documentElement.classList.toggle("dark", theme === "dark");
		try {
			localStorage.setItem(storageKey, theme);
		} catch {}
	}, [storageKey, theme]);

	return [theme, setTheme] as const;
}

function ThemeToggle({ storageKey }: { storageKey: string }) {
	const [theme, setTheme] = useTheme(storageKey);
	const isDark = theme === "dark";
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					size="icon-sm"
					variant="ghost"
					aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
					onClick={() => setTheme(isDark ? "light" : "dark")}
				>
					{isDark ? <SunIcon data-icon="inline-start" /> : <MoonIcon data-icon="inline-start" />}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{isDark ? "Light mode" : "Dark mode"}</TooltipContent>
		</Tooltip>
	);
}

export function DocsApp({ config }: { config: DocsSiteConfig }) {
	const docsBySlug = useMemo(() => buildDocsBySlug(config.docs), [config.docs]);
	const docsBySource = useMemo(() => buildDocsBySource(config.docs), [config.docs]);
	const docsSearch = useMemo(() => createDocsSearch(config.docs), [config.docs]);
	const themeStorageKey = `${config.site.id}:theme`;
	const { slug, navigate } = useDocRouter(docsBySlug, config.defaultDocSlug);
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const [isPaletteOpen, setIsPaletteOpen] = useState(false);
	const [copied, setCopied] = useState(false);

	const activeDoc = getDocOrDefault(slug, docsBySlug, config.defaultDocSlug);
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

						<a
							className="flex min-w-0 items-center gap-2 font-semibold text-[15px]"
							href={`?doc=${config.defaultDocSlug}`}
						>
							<ProjectLogo config={config} />
							<span className="truncate">{config.site.title}</span>
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

						<ThemeToggle storageKey={themeStorageKey} />

						{config.site.badge && (
							<Badge variant="outline" className="hidden rounded-md font-medium sm:inline-flex">
								{config.site.badge}
							</Badge>
						)}
					</div>
				</header>

				{isMenuOpen && (
					<MobileNavigation
						config={config}
						activeSlug={activeDoc.slug}
						search={docsSearch}
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
							config={config}
							activeSlug={activeDoc.slug}
							search={docsSearch}
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

							<MarkdownView
								currentDoc={activeDoc}
								currentSiteId={config.site.id}
								docsBySource={docsBySource}
								markdown={bodyMarkdown}
								onNavigate={navigate}
								siteLinks={config.site.siteLinks ?? []}
							/>
						</article>
					</main>

					<aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] xl:block">
						<TableOfContents activeDoc={activeDoc} headings={headings} onNavigate={navigateAndClose} />
					</aside>
				</div>
			</div>

			<SearchPalette
				config={config}
				docsBySlug={docsBySlug}
				open={isPaletteOpen}
				onOpenChange={setIsPaletteOpen}
				onNavigate={navigateAndClose}
				search={docsSearch}
			/>
		</TooltipProvider>
	);
}

type MobileNavigationProps = {
	config: DocsSiteConfig;
	activeSlug: string;
	search: DocsSearch;
	onClose: () => void;
	onNavigate: (slug: string) => void;
	onOpenSearch: () => void;
};

function MobileNavigation({ config, activeSlug, search, onClose, onNavigate, onOpenSearch }: MobileNavigationProps) {
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
					<div className="flex min-w-0 flex-col gap-3">
						<div className="flex items-center gap-2">
							<ProjectLogo config={config} />
							<h2 id="mobile-nav-title" className="font-semibold text-sm">
								{config.site.title}
							</h2>
						</div>
						<p id="mobile-nav-description" className="sr-only">
							Documentation navigation
						</p>
						<SiteLinks config={config} mode="mobile" />
					</div>
					<Button size="icon-sm" variant="ghost" aria-label="Close navigation" onClick={onClose}>
						<XIcon data-icon="inline-start" />
					</Button>
				</div>
				<Sidebar
					config={config}
					activeSlug={activeSlug}
					search={search}
					onNavigate={onNavigate}
					onOpenSearch={onOpenSearch}
				/>
			</div>
		</div>
	);
}

function SiteLinks({
	config,
	className,
	mode = "desktop",
}: {
	config: DocsSiteConfig;
	className?: string;
	mode?: "desktop" | "mobile" | "sidebar";
}) {
	const links = config.site.siteLinks ?? [];
	if (links.length === 0) {
		return null;
	}

	const childLinksByParent = new Map<string, DocsSiteLink[]>();
	for (const link of links) {
		if (!link.parentId) continue;
		const existing = childLinksByParent.get(link.parentId) ?? [];
		existing.push(link);
		childLinksByParent.set(link.parentId, existing);
	}
	const topLevelLinks = links.filter((link) => !link.parentId);

	return (
		<nav
			className={cn(
				"flex flex-wrap items-center gap-1",
				mode === "mobile" && "items-stretch",
				mode === "sidebar" && "flex-col flex-nowrap items-stretch gap-1",
				className,
			)}
			aria-label="Documentation sites"
		>
			{topLevelLinks.map((link) => {
				const childLinks = childLinksByParent.get(link.id) ?? [];
				if (childLinks.length === 0) {
					return <SiteLinkPill key={link.id} link={link} isCurrent={link.id === config.site.id} />;
				}

				if (mode === "mobile" || mode === "sidebar") {
					const isFamilyCurrent =
						link.id === config.site.id || childLinks.some((childLink) => childLink.id === config.site.id);
					const isChildCurrent = childLinks.some((childLink) => childLink.id === config.site.id);
					return (
						<span key={link.id} className="group/site-link-family flex flex-col items-stretch">
							<SiteLinkPill
								link={link}
								isCurrent={link.id === config.site.id}
								hasChildren
								familyHighlighted={isFamilyCurrent}
								childExpanded={isChildCurrent}
							/>
							<span
								className={cn(
									"grid transition-[grid-template-rows,opacity] duration-300 ease-in group-hover/site-link-family:grid-rows-[1fr] group-hover/site-link-family:opacity-100 group-focus-within/site-link-family:grid-rows-[1fr] group-focus-within/site-link-family:opacity-100",
									isChildCurrent ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
								)}
							>
								<span className="overflow-hidden">
									<span className="ml-3 mt-1 flex flex-col gap-1 border-l pl-2">
										{childLinks.map((childLink) => (
											<SiteLinkPill
												key={childLink.id}
												link={childLink}
												isCurrent={childLink.id === config.site.id}
												isChild
												parentLabel={link.label}
												layout="submenu"
											/>
										))}
									</span>
								</span>
							</span>
						</span>
					);
				}

				return (
					<span key={link.id} className="inline-flex items-center gap-1 rounded-lg border bg-muted/35 p-0.5">
						<SiteLinkPill link={link} isCurrent={link.id === config.site.id} />
						{childLinks.map((childLink) => (
							<SiteLinkPill
								key={childLink.id}
								link={childLink}
								isCurrent={childLink.id === config.site.id}
								isChild
								parentLabel={link.label}
							/>
						))}
					</span>
				);
			})}
		</nav>
	);
}

function SiteLinkPill({
	link,
	isCurrent,
	isChild = false,
	parentLabel,
	hasChildren = false,
	familyHighlighted = false,
	childExpanded = false,
	layout = "inline",
}: {
	link: DocsSiteLink;
	isCurrent: boolean;
	isChild?: boolean;
	parentLabel?: string;
	hasChildren?: boolean;
	familyHighlighted?: boolean;
	childExpanded?: boolean;
	layout?: "inline" | "submenu";
}) {
	const isSubmenuRow = layout === "submenu";
	const content = isSubmenuRow ? (
		<span
			className={cn(
				"flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
				isCurrent
					? "bg-secondary text-secondary-foreground"
					: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
			)}
		>
			{isChild && <CornerDownRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate font-medium text-foreground">{link.label}</span>
				{link.relationLabel && <span className="truncate text-[11px] text-muted-foreground">{link.relationLabel}</span>}
			</span>
		</span>
	) : (
		<span
			className={cn(
				"inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 font-medium text-sm transition-colors",
				isCurrent
					? "bg-secondary text-secondary-foreground"
					: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
				isChild && "border border-dashed border-border bg-background px-2",
				!isCurrent && familyHighlighted && "text-foreground",
			)}
		>
			{isChild && <CornerDownRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
			<span className="inline-flex min-w-0 items-baseline gap-1.5">
				<span>{link.label}</span>
				{link.relationLabel && <span className="text-[11px] text-muted-foreground">{link.relationLabel}</span>}
			</span>
			{link.metaLabel && (
				<span
					className={cn(
						"rounded border px-1 py-0.5 text-[10px] leading-none",
						isCurrent ? "border-border text-muted-foreground" : "border-border/80 text-muted-foreground/80",
					)}
				>
					{link.metaLabel}
				</span>
			)}
			{hasChildren && (
				<ChevronDownIcon
					className={cn(
						"ml-0.5 size-3 shrink-0 text-muted-foreground transition-transform duration-150 group-hover/site-link-family:rotate-180 group-focus-within/site-link-family:rotate-180",
						childExpanded && "rotate-180",
					)}
					aria-hidden="true"
				/>
			)}
		</span>
	);
	const title = [link.description, isChild && parentLabel ? `Part of ${parentLabel}.` : undefined]
		.filter(Boolean)
		.join(" ");

	return (
		<a
			href={link.href}
			aria-current={isCurrent ? "page" : undefined}
			title={title || undefined}
			className={cn(isSubmenuRow && "block")}
		>
			{content}
		</a>
	);
}

type SidebarProps = {
	config: DocsSiteConfig;
	activeSlug: string;
	search: DocsSearch;
	onNavigate: (slug: string) => void;
	onOpenSearch: () => void;
};

function Sidebar({ config, activeSlug, search, onNavigate, onOpenSearch }: SidebarProps) {
	const [filter, setFilter] = useState("");

	const filteredDocs = useMemo(() => filterDocsForSidebar(filter, config.docs, search), [config.docs, filter, search]);
	const hasSiteLinks = (config.site.siteLinks ?? []).length > 0;

	return (
		<div className="flex h-full flex-col">
			{hasSiteLinks && (
				<div className="flex flex-col gap-2 border-b p-4">
					<div className="px-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">Docs</div>
					<SiteLinks config={config} mode="sidebar" />
				</div>
			)}
			<div className="flex flex-col gap-2 border-b p-4">
				<SearchTrigger onOpen={onOpenSearch} />
				<SidebarFilter value={filter} onChange={setFilter} />
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<nav className="flex flex-col gap-6 p-4">
					{config.groups.map((group) => {
						const Icon = iconForGroup(group);
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
			<LlmsLinks config={config} />
		</div>
	);
}

function LlmsLinks({ config }: { config: DocsSiteConfig }) {
	if (!config.site.llms) {
		return null;
	}

	const base = import.meta.env.BASE_URL;
	return (
		<div className="flex flex-col gap-1 border-t p-4 text-xs">
			<div className="px-2 font-medium text-muted-foreground uppercase tracking-wider">For LLMs</div>
			<a
				className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
				href={`${base}llms.txt`}
			>
				llms.txt
				<span className="ml-2 text-[10px] text-muted-foreground/70">index</span>
			</a>
			<a
				className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
				href={`${base}llms-full.txt`}
			>
				llms-full.txt
				<span className="ml-2 text-[10px] text-muted-foreground/70">all docs, paste-ready</span>
			</a>
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

function useDocRouter(docsBySlug: Map<string, Doc>, defaultDocSlug: string) {
	const [slug, setSlug] = useState(() => getDocSlugFromLocation(docsBySlug, defaultDocSlug));

	useEffect(() => {
		function syncFromLocation() {
			setSlug(getDocSlugFromLocation(docsBySlug, defaultDocSlug));
		}

		window.addEventListener("popstate", syncFromLocation);
		return () => window.removeEventListener("popstate", syncFromLocation);
	}, [defaultDocSlug, docsBySlug]);

	const navigate = useCallback(
		(nextSlug: string, headingId?: string) => {
			const nextDoc = getDocOrDefault(nextSlug, docsBySlug, defaultDocSlug);
			const url = new URL(window.location.href);
			url.searchParams.set("doc", nextDoc.slug);
			url.hash = headingId ? headingId : "";
			window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
			setSlug(nextDoc.slug);
			scrollAfterNavigation(headingId);
		},
		[defaultDocSlug, docsBySlug],
	);

	return { slug, navigate };
}

function getDocSlugFromLocation(docsBySlug: Map<string, Doc>, defaultDocSlug: string) {
	const value = new URL(window.location.href).searchParams.get("doc");
	return value && docsBySlug.has(value) ? value : defaultDocSlug;
}

function getDocOrDefault(slug: string, docsBySlug: Map<string, Doc>, defaultDocSlug: string) {
	const doc = docsBySlug.get(slug) ?? docsBySlug.get(defaultDocSlug);
	if (!doc) {
		throw new Error("No documentation pages are registered.");
	}

	return doc;
}

function filterDocsForSidebar(query: string, docs: readonly Doc[], search: DocsSearch): Doc[] {
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

function assetUrl(path: string) {
	if (/^(?:[a-z]+:|\/)/i.test(path)) {
		return path;
	}
	return `${import.meta.env.BASE_URL}${path}`;
}

function assetSrcSet(srcSet: string) {
	return srcSet
		.split(",")
		.map((entry) => {
			const [path, descriptor] = entry.trim().split(/\s+/, 2);
			return path ? `${assetUrl(path)}${descriptor ? ` ${descriptor}` : ""}` : "";
		})
		.filter(Boolean)
		.join(", ");
}

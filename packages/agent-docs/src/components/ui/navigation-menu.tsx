"use client";

import { ChevronDownIcon } from "lucide-react";
import { NavigationMenu as NavigationMenuPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "../../lib/utils";

function NavigationMenu({
	className,
	children,
	viewport = true,
	...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Root> & {
	viewport?: boolean;
}) {
	return (
		<NavigationMenuPrimitive.Root
			data-slot="navigation-menu"
			className={cn("relative flex max-w-max flex-1 items-center justify-center", className)}
			{...props}
		>
			{children}
			{viewport && <NavigationMenuViewport />}
		</NavigationMenuPrimitive.Root>
	);
}

function NavigationMenuList({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.List>) {
	return (
		<NavigationMenuPrimitive.List
			data-slot="navigation-menu-list"
			className={cn("group flex flex-1 list-none items-center justify-center gap-1", className)}
			{...props}
		/>
	);
}

function NavigationMenuItem({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.Item>) {
	return <NavigationMenuPrimitive.Item data-slot="navigation-menu-item" className={cn("relative", className)} {...props} />;
}

const navigationMenuTriggerStyle =
	"inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2.5 font-medium text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground";

function NavigationMenuTrigger({
	className,
	children,
	...props
}: React.ComponentProps<typeof NavigationMenuPrimitive.Trigger>) {
	return (
		<NavigationMenuPrimitive.Trigger
			data-slot="navigation-menu-trigger"
			className={cn(navigationMenuTriggerStyle, "group", className)}
			{...props}
		>
			{children}
			<ChevronDownIcon
				className="relative top-px size-3 transition-transform duration-200 group-data-[state=open]:rotate-180"
				aria-hidden="true"
			/>
		</NavigationMenuPrimitive.Trigger>
	);
}

function NavigationMenuContent({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.Content>) {
	return (
		<NavigationMenuPrimitive.Content
			data-slot="navigation-menu-content"
			className={cn(
				"top-0 left-0 w-full data-[motion=from-end]:animate-in data-[motion=from-start]:animate-in data-[motion=to-end]:animate-out data-[motion=to-start]:animate-out data-[motion=from-end]:slide-in-from-right-52 data-[motion=from-start]:slide-in-from-left-52 data-[motion=to-end]:slide-out-to-right-52 data-[motion=to-start]:slide-out-to-left-52 md:absolute md:w-auto",
				className,
			)}
			{...props}
		/>
	);
}

function NavigationMenuLink({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.Link>) {
	return (
		<NavigationMenuPrimitive.Link
			data-slot="navigation-menu-link"
			className={cn(
				"block rounded-md p-2.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
				className,
			)}
			{...props}
		/>
	);
}

function NavigationMenuViewport({ className, ...props }: React.ComponentProps<typeof NavigationMenuPrimitive.Viewport>) {
	return (
		<div className="absolute top-full left-0 isolate z-50 flex justify-center">
			<NavigationMenuPrimitive.Viewport
				data-slot="navigation-menu-viewport"
				className={cn(
					"origin-top-center relative mt-1.5 h-(--radix-navigation-menu-viewport-height) w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-90 md:w-(--radix-navigation-menu-viewport-width)",
					className,
				)}
				{...props}
			/>
		</div>
	);
}

export {
	NavigationMenu,
	NavigationMenuContent,
	NavigationMenuItem,
	NavigationMenuLink,
	NavigationMenuList,
	NavigationMenuTrigger,
	navigationMenuTriggerStyle,
};

import * as React from "react";
import { PanelLeft } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * Minimal implementation of the shadcn Sidebar API surface (SidebarProvider /
 * Sidebar / SidebarContent / SidebarFooter / SidebarTrigger), with the
 * collapsible="icon" behavior: the rail collapses to icon-only — per design,
 * an acceptable desktop state, swapped for a bottom tab bar on mobile.
 *
 * Only what this console uses is implemented; no Radix — state + CSS width
 * transition, which is all "collapsible" needs at this scale.
 */

type SidebarState = { collapsed: boolean; toggle: () => void };

const SidebarContext = React.createContext<SidebarState>({ collapsed: false, toggle: () => undefined });

export function SidebarProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [collapsed, setCollapsed] = React.useState(false);
  const toggle = React.useCallback(() => setCollapsed((c) => !c), []);
  return <SidebarContext.Provider value={React.useMemo(() => ({ collapsed, toggle }), [collapsed, toggle])}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarState {
  return React.useContext(SidebarContext);
}

export function Sidebar({ className, children }: { className?: string; children: React.ReactNode }): React.ReactElement {
  const { collapsed } = useSidebar();
  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-40 hidden flex-col gap-4 border-r border-sidebar-border bg-sidebar p-3 transition-[width] duration-200 ease-in-out md:flex",
        collapsed ? "w-14" : "w-60",
        className,
      )}
      data-collapsed={collapsed}
    >
      {children}
    </aside>
  );
}

export function SidebarHeader({ className, children }: { className?: string; children: React.ReactNode }): React.ReactElement {
  return <div className={cn("flex items-center gap-2.5 px-1 pt-1", className)}>{children}</div>;
}

export function SidebarContent({ className, children }: { className?: string; children: React.ReactNode }): React.ReactElement {
  return <div className={cn("flex flex-col gap-1", className)}>{children}</div>;
}

export function SidebarFooter({ className, children }: { className?: string; children: React.ReactNode }): React.ReactElement {
  return <div className={cn("mt-auto flex flex-col gap-1.5", className)}>{children}</div>;
}

/** Group label; on the collapsed rail there's no room for it. */
export function SidebarLabel({ className, children }: { className?: string; children: React.ReactNode }): React.ReactElement | null {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return <p className={cn("px-1 text-xs font-medium text-muted-foreground", className)}>{children}</p>;
}

export function SidebarTrigger(): React.ReactElement {
  const { collapsed, toggle } = useSidebar();
  return (
    <button
      onClick={toggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <PanelLeft className={cn("size-4 transition-transform", collapsed && "rotate-180")} />
    </button>
  );
}

/** Nav item: icon + label; on the collapsed rail, label lives in a tooltip. */
export function SidebarMenuItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  const { collapsed } = useSidebar();
  return (
    <button
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/menu-item relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm font-medium transition-colors",
        collapsed && "justify-center px-0",
        active
          ? "bg-primary text-primary-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
      {collapsed && active && <span className="absolute -left-3 h-5 w-1 rounded-full bg-primary" />}
    </button>
  );
}
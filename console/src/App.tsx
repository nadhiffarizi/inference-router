import { useEffect } from "react";
import { BarChart3, Eye, KeyRound, MessageSquareText, Network, LogOut } from "lucide-react";
import { navigate, usePath } from "./router";
import { AuthProvider, useAuth } from "./auth";
import { LoginView } from "./login";
import { Playground } from "./playground";
import { ApiKeysView } from "./keys";
import { UsageView } from "./usage";
import { ObservabilityView } from "./observability";
import { Badge } from "./components/ui/badge";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarHeader,
  SidebarLabel, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar,
} from "./components/ui/sidebar";
import { cn, usd } from "./lib/utils";

/**
 * Shell: login gate → role-scoped sidebar. Admin IS a tenant: identical
 * Playground / API Keys / Usage flows plus one extra menu, Observability
 * (cross-tenant reads + decision log), enforced server-side.
 */

type Tab = "playground" | "keys" | "usage" | "observability";

const NAV: {
  id: Tab; path: string; label: string; icon: typeof BarChart3; role: "all" | "admin";
  title: string; subtitle: string;
}[] = [
  { id: "playground", path: "/playground", label: "Playground", icon: MessageSquareText, role: "all", title: "Playground", subtitle: "support assistant, live through the gateway" },
  { id: "keys", path: "/keys", label: "API Keys", icon: KeyRound, role: "all", title: "API Keys", subtitle: "issue, copy, and the endpoints to integrate against" },
  { id: "usage", path: "/usage", label: "Usage", icon: BarChart3, role: "all", title: "Usage", subtitle: "requests, spend, quota remaining — own tenant" },
  { id: "observability", path: "/observability", label: "Observability", icon: Eye, role: "admin", title: "Observability", subtitle: "all tenants + routing decision log" },
];

export function App(): React.ReactElement {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

function Gate(): React.ReactElement {
  const { me, loading, logout } = useAuth();
  const path = usePath();

  // Role-scoped menu; the active tab is the URL, so refresh/deep links work.
  const menus = NAV.filter((n) => n.role === "all" || (me?.user.role === "admin"));
  const current = menus.find((n) => n.path === path) ?? menus[0]!;
  const activeTab = current.id;

  // Unknown or role-gated path → snap to the first permitted menu.
  useEffect(() => {
    if (me && window.location.pathname !== current.path) navigate(current.path, true);
  }, [me, current.path]);

  if (loading) {
    return <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">loading…</div>;
  }
  if (!me) {
    return <LoginView onLoggedIn={() => window.location.reload()} />;
  }

  return (
    <SidebarProvider>
      <div className="min-h-svh bg-muted/40">
        <Sidebar>
          <SidebarHeader>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Network className="size-4" />
            </span>
            <BrandText />
          </SidebarHeader>

          <SidebarLabel>menu</SidebarLabel>
          <SidebarContent>
            {menus.map((n) => (
              <SidebarMenuItem
                key={n.id}
                icon={n.icon}
                label={n.label}
                active={activeTab === n.id}
                onClick={() => navigate(n.path)}
              />
            ))}
          </SidebarContent>

          <SidebarFooter>
            <SidebarLabel>
              identity
            </SidebarLabel>
            <div className="rounded-lg border p-2.5">
              <p className="truncate text-xs font-medium">{me.user.email}</p>
              <div className="mt-1 flex items-center justify-between gap-2">
                <Badge variant={me.user.role === "admin" ? "info" : "secondary"}>{me.user.role === "admin" ? "admin" : "product team"}</Badge>
                <span className="font-mono text-[10px] text-muted-foreground">{me.user.tenant.name}</span>
              </div>
            </div>
            <button
              onClick={() => void logout()}
              className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <LogOut className="size-3.5" /> sign out
            </button>
          </SidebarFooter>
        </Sidebar>

        <MainColumn>
          <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-2.5 backdrop-blur md:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <span className="hidden md:flex"><SidebarTrigger /></span>
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold tracking-tight">{current.title}</h1>
                <p className="truncate text-sm text-muted-foreground">{current.subtitle}</p>
              </div>
            </div>
            <Badge variant="outline" className="hidden text-muted-foreground md:inline-flex">
              {me.user.tenant.name} · {me.usage.usdSpend > 0 ? `${usd(me.usage.usdSpend)} today` : "no spend today"}
            </Badge>
          </header>

          <main className="px-4 pb-24 md:px-8 md:pb-10">
            {activeTab === "playground" && <Playground />}
            {activeTab === "keys" && <ApiKeysView />}
            {activeTab === "usage" && <UsageView />}
            {activeTab === "observability" && <ObservabilityView />}
          </main>
        </MainColumn>

        {/* mobile bottom tab bar (design.md: no hamburger on mobile) */}
        <nav className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-sidebar-border bg-sidebar px-2 pb-[env(safe-area-inset-bottom)] pt-1.5 md:hidden">
          {menus.map((n) => {
            const Icon = n.icon;
            const active = activeTab === n.id;
            return (
              <button
                key={n.id}
                onClick={() => navigate(n.path)}
                className={cn(
                  "flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] font-medium",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <Icon className={cn("size-5", active && "fill-primary/15")} />
                {n.label.split(" ")[0]!.slice(0, 9)}
                {active && <span className="size-1 rounded-full bg-primary" />}
              </button>
            );
          })}
        </nav>
      </div>
    </SidebarProvider>
  );
}

function BrandText(): React.ReactElement | null {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return (
    <div className="min-w-0 leading-tight">
      <p className="truncate text-sm font-semibold">Inference Router</p>
      <p className="truncate text-xs text-muted-foreground">mini · console</p>
    </div>
  );
}

/** Content column whose left padding follows the collapsible rail width. */
function MainColumn({ children }: { children: React.ReactNode }): React.ReactElement {
  const { collapsed } = useSidebar();
  return (
    <div className={cn("min-h-svh transition-[padding] duration-200 ease-in-out md:pl-60", collapsed && "md:pl-14")}>
      {children}
    </div>
  );
}
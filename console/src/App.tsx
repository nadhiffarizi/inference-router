import { useState } from "react";
import { BarChart3, MessageSquareText, Network, UserRound } from "lucide-react";
import { Playground } from "./playground";
import { UsageView } from "./usage";
import { Badge } from "./components/ui/badge";
import { Select } from "./components/ui/input";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarHeader,
  SidebarLabel, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar,
} from "./components/ui/sidebar";
import { cn } from "./lib/utils";

/**
 * App shell per klipsi design.md: collapsible shadcn sidebar on desktop
 * (full ↔ icon rail via SidebarTrigger), top bar inside the content area,
 * fixed bottom tab bar on mobile — no hamburger.
 */

const KEYS = [
  { label: "tenant: demo", hint: "200 req/day", key: "sk_demo_key_0000000000000000" },
  { label: "tenant: stress", hint: "3 req/day", key: "sk_stress_key_0000000000000000" },
];

type Tab = "playground" | "usage";

const NAV: { id: Tab; label: string; icon: typeof BarChart3; title: string; subtitle: string }[] = [
  { id: "playground", label: "Chat Playground", icon: MessageSquareText, title: "Playground", subtitle: "support assistant, live through the gateway" },
  { id: "usage", label: "Usage", icon: BarChart3, title: "Usage", subtitle: "requests, cost, quota, routing decisions" },
];

export function App(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("playground");
  const [apiKey, setApiKey] = useState(KEYS[0]!.key);
  const current = NAV.find((n) => n.id === tab)!;

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

          <SidebarLabel>workspace</SidebarLabel>
          <SidebarContent>
            {NAV.map((n) => (
              <SidebarMenuItem
                key={n.id}
                icon={n.icon}
                label={n.label}
                active={tab === n.id}
                onClick={() => setTab(n.id)}
              />
            ))}
          </SidebarContent>

          <SidebarFooter>
            <SidebarLabel>
              <span className="inline-flex items-center gap-1.5">
                <UserRound className="size-3.5" /> tenant
              </span>
            </SidebarLabel>
            <Select value={apiKey} onChange={(e) => setApiKey(e.target.value)} aria-label="tenant key">
              {KEYS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </Select>
            <TenantHint apiKey={apiKey} />
          </SidebarFooter>
        </Sidebar>

        {/* content column: padding tracks the rail (inside provider → can read collapse state) */}
        <MainColumn>
          <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <span className="hidden md:flex"><SidebarTrigger /></span>
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold tracking-tight">{current.title}</h1>
                <p className="truncate text-xs text-muted-foreground">{current.subtitle}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="hidden text-muted-foreground md:inline-flex">
                {KEYS.find((k) => k.key === apiKey)?.label}
              </Badge>
              <Select
                className="h-8 w-36 text-xs md:hidden"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                aria-label="tenant key"
              >
                {KEYS.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </div>
          </header>

          <main className="px-4 pb-24 md:px-8 md:pb-10">
            {tab === "playground" ? <Playground apiKey={apiKey} /> : <UsageView apiKey={apiKey} />}
          </main>
        </MainColumn>

        {/* mobile bottom tab bar (design.md: no hamburger on mobile) */}
        <nav className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-sidebar-border bg-sidebar px-2 pb-[env(safe-area-inset-bottom)] pt-1.5 md:hidden">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = tab === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setTab(n.id)}
                className={cn(
                  "flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] font-medium",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <Icon className={cn("size-5", active && "fill-primary/15")} />
                {n.label.split(" ").pop()}
                {active && <span className="size-1 rounded-full bg-primary" />}
              </button>
            );
          })}
        </nav>
      </div>
    </SidebarProvider>
  );
}

/** Brand text hides on the collapsed rail (icon stays). */
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

function TenantHint({ apiKey }: { apiKey: string }): React.ReactElement | null {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return <p className="px-1 text-xs text-muted-foreground">{KEYS.find((k) => k.key === apiKey)?.hint}</p>;
}

/** Content column whose left padding follows the collapsible rail width. */
function MainColumn({ children }: { children: React.ReactNode }): React.ReactElement {
  const { collapsed } = useSidebar();
  return (
    <div
      className={cn(
        "min-h-svh transition-[padding] duration-200 ease-in-out md:pl-60",
        collapsed && "md:pl-14",
      )}
    >
      {children}
    </div>
  );
}
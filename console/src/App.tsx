import { useState } from "react";
import { BarChart3, MessageSquareText, Network, UserRound } from "lucide-react";
import { Playground } from "./playground";
import { UsageView } from "./usage";
import { Badge } from "./components/ui/badge";
import { Select } from "./components/ui/input";
import { cn } from "./lib/utils";

/**
 * App shell per klipsi design.md: persistent sidebar on desktop (icon + label
 * rows, active item filled), a top bar inside the content area, and a fixed
 * bottom tab bar on mobile — no hamburger, content clears the bar.
 */

const KEYS = [
  { label: "tenant: demo", hint: "200 req/day", key: "sk_demo_key_0000000000000000" },
  { label: "tenant: stress", hint: "3 req/day", key: "sk_stress_key_0000000000000000" },
];

type Tab = "playground" | "usage";

const NAV: { id: Tab; label: string; icon: typeof BarChart3; title: string; subtitle: string }[] = [
  { id: "playground", label: "Playground", icon: MessageSquareText, title: "Playground", subtitle: "support assistant, live through the gateway" },
  { id: "usage", label: "Usage", icon: BarChart3, title: "Usage", subtitle: "requests, cost, quota, routing decisions" },
];

export function App(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("playground");
  const [apiKey, setApiKey] = useState(KEYS[0]!.key);
  const current = NAV.find((n) => n.id === tab)!;

  const nav = (expanded: boolean) => (
    <>
      {NAV.map((n) => {
        const Icon = n.icon;
        const active = tab === n.id;
        return (
          <button
            key={n.id}
            onClick={() => setTab(n.id)}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              expanded ? "w-full justify-start" : "justify-center",
              active
                ? "bg-primary text-primary-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4" />
            {expanded && n.label}
          </button>
        );
      })}
    </>
  );

  return (
    <div className="min-h-svh bg-muted/40">
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col gap-5 border-r border-sidebar-border bg-sidebar p-4 md:flex">
        <div className="flex items-center gap-2.5 px-2 pt-1">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Network className="size-4" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold">Inference Router</p>
            <p className="text-xs text-muted-foreground">mini · console</p>
          </div>
        </div>
        <nav className="flex flex-col gap-1">{nav(true)}</nav>
        <div className="mt-auto">
          <label className="mb-1.5 block px-2 text-xs font-medium text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <UserRound className="size-3.5" /> tenant
            </span>
          </label>
          <Select value={apiKey} onChange={(e) => setApiKey(e.target.value)}>
            {KEYS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </Select>
          <p className="mt-1.5 px-2 text-xs text-muted-foreground">{KEYS.find((k) => k.key === apiKey)?.hint}</p>
        </div>
      </aside>

      {/* content column */}
      <div className="md:pl-60">
        {/* top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-8">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{current.title}</h1>
            <p className="text-xs text-muted-foreground">{current.subtitle}</p>
          </div>
          <div className="flex items-center gap-2 md:hidden">
            <Select className="h-8 w-36 text-xs" value={apiKey} onChange={(e) => setApiKey(e.target.value)}>
              {KEYS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </Select>
          </div>
          <Badge variant="outline" className="hidden text-muted-foreground md:inline-flex">
            {KEYS.find((k) => k.key === apiKey)?.label}
          </Badge>
        </header>

        <main className="px-4 pb-24 md:px-8 md:pb-10">
          {tab === "playground" ? <Playground apiKey={apiKey} /> : <UsageView apiKey={apiKey} />}
        </main>
      </div>

      {/* mobile bottom tab bar */}
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
              <Icon className={cn("size-5", active ? "fill-primary/15" : "")} />
              {n.label}
              {active && <span className="size-1 rounded-full bg-primary" />}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
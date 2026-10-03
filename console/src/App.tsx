import { useState } from "react";
import { Playground } from "./playground";
import { UsageView } from "./usage";

const KEYS = [
  { label: "tenant: demo (200 req/day)", key: "sk_demo_key_0000000000000000" },
  { label: "tenant: stress (3 req/day)", key: "sk_stress_key_0000000000000000" },
];

export function App(): React.ReactElement {
  const [tab, setTab] = useState<"playground" | "usage">("playground");
  const [apiKey, setApiKey] = useState(KEYS[0]!.key);

  return (
    <div className="app">
      <header>
        <h1>Mini Inference Router</h1>
        <nav>
          <button className={tab === "playground" ? "active" : ""} onClick={() => setTab("playground")}>
            Playground
          </button>
          <button className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}>
            Usage
          </button>
        </nav>
        <select value={apiKey} onChange={(e) => setApiKey(e.target.value)} aria-label="tenant key">
          {KEYS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
          {KEYS.every((k) => k.key !== apiKey) && <option value={apiKey}>custom key…</option>}
        </select>
      </header>
      {tab === "playground" ? <Playground apiKey={apiKey} /> : <UsageView apiKey={apiKey} />}
    </div>
  );
}
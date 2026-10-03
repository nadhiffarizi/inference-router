import { useEffect, useState } from "react";
import { fetchUsage, type UsageResponse } from "./api";

/** The usage view: requests + cost per tenant, remaining quota, decision log. */

export function UsageView({ apiKey }: { apiKey: string }): React.ReactElement {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchUsage(apiKey)
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((err: Error) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [apiKey]);

  if (error) return <div className="card error">{error}</div>;
  if (!data) return <p className="muted">{loading ? "loading…" : ""}</p>;

  return (
    <div className="usage">
      <h2>Tenants</h2>
      <table>
        <thead>
          <tr>
            <th>tenant</th>
            <th>requests today</th>
            <th>tokens today</th>
            <th>cost today</th>
            <th>remaining quota</th>
            <th>total requests</th>
            <th>total cost</th>
          </tr>
        </thead>
        <tbody>
          {data.tenants.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{t.today.requests}</td>
              <td>{t.today.tokens}</td>
              <td>${t.today.costsUsd.toFixed(4)}</td>
              <td>
                {t.remaining.requests} req · {t.remaining.tokens} tok
              </td>
              <td>{t.totals.requests}</td>
              <td>${t.totals.costUsd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Routing decisions (latest 25)</h2>
      <table>
        <thead>
          <tr>
            <th>request</th>
            <th>capability</th>
            <th>served by</th>
            <th>fallback</th>
            <th>plan</th>
          </tr>
        </thead>
        <tbody>
          {data.recentRoutingDecisions.map((d) => (
            <tr key={d.requestId}>
              <td>
                <code>{d.requestId.slice(0, 8)}</code>
              </td>
              <td>{d.capability}</td>
              <td>{d.chosenBackendId ?? "—"}</td>
              <td>{d.fallbackTriggered ? "✔ fired" : "—"}</td>
              <td>
                <ol className="plan">
                  {d.plan.map((s, i) => (
                    <li key={i}>
                      {s.backendId} → {s.action}
                    </li>
                  ))}
                </ol>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
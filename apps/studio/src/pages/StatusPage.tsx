import type { BindingCheck } from "@avs/contracts";
import type { ProviderCosts, ProviderStatus } from "@avs/contracts";
import { useEffect, useState } from "react";
import { useHealth } from "../hooks/useHealth";
import { getProviderCosts, listProviders } from "../services/api";

const LABELS = { database: "Database (D1)", storage: "Media storage (R2)", workflows: "Workflows" };

function Binding({ check }: { check: BindingCheck }) {
  const cls = check.status === "ok" ? "ok" : check.status === "missing" ? "warn" : "off";
  const text =
    check.status === "ok"
      ? `Connected${check.latency_ms != null ? ` · ${check.latency_ms} ms` : ""}`
      : check.status === "missing"
        ? "Not configured"
        : `Error: ${check.detail ?? "unknown"}`;
  return (
    <>
      <span className={`dot ${cls}`} /> {text}
    </>
  );
}

const CAPABILITY_LABELS: Record<ProviderStatus["capability"], string> = {
  text: "Text (scripts)",
  image: "Images",
  video: "Video",
  image_to_video: "Image to video",
  voice: "Narration",
  music: "Music",
  sfx: "Sound effects",
};

const money = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;

function Costs() {
  const [costs, setCosts] = useState<ProviderCosts | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getProviderCosts().then(setCosts, (e: unknown) =>
      setError(e instanceof Error ? e.message : "Could not load."),
    );
  }, []);
  if (error) return <p className="bad">{error}</p>;
  if (!costs) return <p className="muted">Loading costs…</p>;
  const p = costs.paid;
  return (
    <>
      <p>
        <span className={`dot ${p.enabled ? "ok" : "off"}`} />{" "}
        {p.enabled
          ? `Paid providers on: ${money(p.spent_today_usd)} of ${money(p.daily_budget_usd)} used today (you: ${money(p.you_spent_today_usd)} of ${money(p.user_daily_budget_usd)}).`
          : "Paid providers are off. Only free providers are used."}
      </p>
      {costs.last_30_days.length === 0 ? (
        <p className="muted">No media generated in the last 30 days.</p>
      ) : (
        <table className="providers">
          <thead>
            <tr>
              <th scope="col">Provider (30 days)</th>
              <th scope="col">Uses</th>
              <th scope="col">Estimated</th>
              <th scope="col">Actual</th>
            </tr>
          </thead>
          <tbody>
            {costs.last_30_days.map((c) => (
              <tr key={`${c.provider_name}-${c.capability}-${c.tier}`}>
                <td>
                  {c.provider_name}
                  <small className="muted block">
                    {CAPABILITY_LABELS[c.capability]} · {c.tier}
                  </small>
                </td>
                <td>{c.calls}</td>
                <td>{money(c.estimated_usd)}</td>
                <td>{c.actual_usd == null ? "not reported" : money(c.actual_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Providers() {
  const [rows, setRows] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    listProviders().then(setRows, (e: unknown) =>
      setError(e instanceof Error ? e.message : "Could not load."),
    );
  }, []);
  if (error) return <p className="bad">{error}</p>;
  if (!rows) return <p className="muted">Loading providers…</p>;
  return (
    <table className="providers">
      <thead>
        <tr>
          <th scope="col">Capability</th>
          <th scope="col">Provider</th>
          <th scope="col">Today</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.capability}-${r.provider_name ?? i}`}>
            <td>{CAPABILITY_LABELS[r.capability]}</td>
            <td>
              <span
                className={`dot ${r.available && r.enabled ? (r.health_status === "degraded" || r.health_status === "down" ? "warn" : "ok") : "off"}`}
              />
              {r.provider_name ?? "None"}
              {r.tier && (
                <small className="muted block">
                  {r.tier === "paid" ? "Paid" : "Free"}
                  {r.usd_per_unit ? ` · ${money(r.usd_per_unit)} per ${r.cost_unit}` : ""}
                </small>
              )}
              {r.cooldown_until && new Date(r.cooldown_until) > new Date() && (
                <small className="warn block">
                  Paused until {new Date(r.cooldown_until).toLocaleTimeString()}
                  {r.last_error ? `: ${r.last_error}` : ""}
                </small>
              )}
              {r.note && <small className="muted block">{r.note}</small>}
            </td>
            <td>
              {r.used_today}
              {r.daily_limit != null ? ` / ${r.daily_limit}` : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StatusPage() {
  const health = useHealth();
  return (
    <section className="narrow">
      <h1>System status</h1>
      <div className="card" aria-live="polite">
        {health.kind === "loading" && <p className="muted">Checking the API…</p>}
        {health.kind === "ok" && (
          <dl className="kv">
            <dt>API</dt>
            <dd>
              <span className={`dot ${health.data.status === "ok" ? "ok" : "warn"}`} />{" "}
              {health.data.status === "ok" ? "Online" : "Online, degraded"}
            </dd>
            {(Object.keys(LABELS) as (keyof typeof LABELS)[]).map((k) => (
              <div key={k} className="row">
                <dt>{LABELS[k]}</dt>
                <dd>
                  <Binding check={health.data.bindings[k]} />
                </dd>
              </div>
            ))}
            <dt>Service</dt>
            <dd>
              {health.data.service} v{health.data.version}
            </dd>
            <dt>Environment</dt>
            <dd>{health.data.environment}</dd>
          </dl>
        )}
        {health.kind === "error" && (
          <p className="bad">
            <span className="dot off" /> API unreachable: {health.message}
          </p>
        )}
      </div>
      <h2 className="section-title">AI providers</h2>
      <div className="card">
        <Providers />
      </div>
      <h2 className="section-title">Generation costs</h2>
      <div className="card">
        <Costs />
      </div>
    </section>
  );
}

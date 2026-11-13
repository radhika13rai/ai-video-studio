import type { BindingCheck } from "@avs/contracts";
import type { ProviderStatus } from "@avs/contracts";
import { useEffect, useState } from "react";
import { useHealth } from "../hooks/useHealth";
import { listProviders } from "../services/api";

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
  voice: "Narration",
  music: "Music",
};

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
                className={`dot ${r.available && r.enabled ? (r.health_status === "degraded" ? "warn" : "ok") : "off"}`}
              />
              {r.provider_name ?? "None"}
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
    </section>
  );
}

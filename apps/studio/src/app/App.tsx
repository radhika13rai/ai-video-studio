import type { BindingCheck } from "@avs/contracts";
import { useHealth } from "../hooks/useHealth";

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
import "./app.css";

export function App() {
  const health = useHealth();
  return (
    <main className="shell">
      <header className="brand">
        <div className="logo" aria-hidden="true">
          ▶
        </div>
        <div>
          <h1>AI Video Studio</h1>
          <p>One prompt in, one finished video out.</p>
        </div>
      </header>

      <section className="card" aria-live="polite">
        <h2>System status</h2>
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
      </section>

      <p className="muted small">
        Foundation build. Projects, agents and the renderer arrive in later tasks.
      </p>
    </main>
  );
}

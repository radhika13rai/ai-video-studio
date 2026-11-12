import { useHealth } from "../hooks/useHealth";
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
              <span className="dot ok" /> Online
            </dd>
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

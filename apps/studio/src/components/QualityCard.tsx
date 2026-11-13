import type { QualityReport } from "@avs/contracts";

const ICON = { pass: "✓", warn: "!", fail: "✕" } as const;
const TITLE = { passed: "Passed", warning: "Passed with warnings", failed: "Failed" } as const;

/** The latest automated quality report: overall verdict, score, each check and advice. */
export function QualityCard({ report }: { report: QualityReport }) {
  return (
    <div className="card quality-card">
      <div className="quality-head">
        <h2>Quality check</h2>
        <span
          className={`badge tone-${report.overall_status === "passed" ? "success" : report.overall_status === "warning" ? "attention" : "danger"}`}
        >
          {TITLE[report.overall_status]}
          {report.score != null && ` · ${Math.round(report.score)}/100`}
        </span>
      </div>
      <ul className="checks">
        {report.checks.items.map((c) => (
          <li key={c.id} className={`check check-${c.status}`}>
            <span className="check-icon" aria-hidden="true">
              {ICON[c.status]}
            </span>
            <span>
              <strong>{c.label}</strong> <span className="muted">{c.detail}</span>
              <span className="sr-only"> ({c.status})</span>
            </span>
          </li>
        ))}
      </ul>
      {report.recommendations.length > 0 && (
        <ul className="notes">
          {report.recommendations.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

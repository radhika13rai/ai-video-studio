import type { ProjectStatus } from "@avs/types";
import { STATUS_DISPLAY } from "../lib/format";

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const d = STATUS_DISPLAY[status];
  return (
    <span className={`badge tone-${d.tone}`} title={d.hint} data-status={status}>
      {d.tone === "active" && <span className="pulse" aria-hidden="true" />}
      {d.label}
    </span>
  );
}

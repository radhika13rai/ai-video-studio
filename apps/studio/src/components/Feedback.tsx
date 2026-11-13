import type { ReactNode } from "react";

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="alert error" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn small" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-art" aria-hidden="true">
        🎬
      </div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Skeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card skeleton" />
      ))}
    </div>
  );
}

import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

/** Minimal history-based router. The Worker serves index.html for unknown paths (SPA mode). */

const EVENT = "avs:navigate";

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(EVENT));
  window.scrollTo?.(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(() => location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    window.addEventListener("popstate", update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return path;
}

export type Route =
  | { name: "projects" }
  | { name: "new" }
  | { name: "project"; id: string }
  | { name: "edit"; id: string }
  | { name: "status" }
  | { name: "not-found" };

export function matchRoute(path: string): Route {
  const p = path.replace(/\/+$/, "") || "/";
  if (p === "/" || p === "/projects") return { name: "projects" };
  if (p === "/projects/new") return { name: "new" };
  if (p === "/status") return { name: "status" };
  const e = /^\/projects\/([^/]+)\/edit$/.exec(p);
  if (e?.[1]) return { name: "edit", id: decodeURIComponent(e[1]) };
  const m = /^\/projects\/([^/]+)$/.exec(p);
  if (m?.[1]) return { name: "project", id: decodeURIComponent(m[1]) };
  return { name: "not-found" };
}

/** An <a> that navigates without a page reload (but still supports new-tab clicks). */
export function Link({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}

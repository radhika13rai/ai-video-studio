import type { User } from "@avs/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { Link, type Route } from "../lib/router";
import { getMe } from "../services/api";

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`nav-link${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      {children}
    </Link>
  );
}

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const [me, setMe] = useState<User | null>(null);
  useEffect(() => {
    getMe().then(setMe, () => setMe(null));
  }, []);
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/" className="brand" aria-label="AI Video Studio home">
            <span className="logo" aria-hidden="true">
              ▶
            </span>
            <span className="brand-name">AI Video Studio</span>
          </Link>
          <nav className="nav" aria-label="Main">
            <NavLink href="/" active={route.name === "projects" || route.name === "project"}>
              Projects
            </NavLink>
            <NavLink href="/status" active={route.name === "status"}>
              Status
            </NavLink>
          </nav>
          <div className="topbar-right">
            {me && (
              <span className="user" title={me.email}>
                {me.display_name ?? me.email}
              </span>
            )}
            <Link href="/projects/new" className="btn primary">
              + New video
            </Link>
          </div>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

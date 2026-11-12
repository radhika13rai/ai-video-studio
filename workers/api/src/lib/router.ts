import { ApiError } from "./errors";

export type Params = Record<string, string>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Handler<C> = (ctx: C, params: Params) => Promise<Response>;

interface Route<C> {
  method: Method;
  regex: RegExp;
  keys: string[];
  handler: Handler<C>;
}

/** A tiny path router: `/projects/:id/jobs` style patterns, 404 and 405 handling. */
export class Router<C> {
  private routes: Route<C>[] = [];

  on(method: Method, pattern: string, handler: Handler<C>): this {
    const keys: string[] = [];
    const source = pattern.replace(/:(\w+)/g, (_, k: string) => {
      keys.push(k);
      return "([^/]+)";
    });
    this.routes.push({ method, regex: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }

  /** Returns the matching handler, or throws 404 / 405 (with an Allow header). */
  match(method: string, path: string): { handler: Handler<C>; params: Params } {
    const allowed = new Set<string>();
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (!m) continue;
      const routeMethods = r.method === "GET" ? ["GET", "HEAD"] : [r.method];
      if (routeMethods.includes(method)) {
        const params: Params = {};
        r.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(m[i + 1] ?? "");
        });
        return { handler: r.handler, params };
      }
      routeMethods.forEach((x) => allowed.add(x));
    }
    if (allowed.size > 0)
      throw new ApiError(
        405,
        "METHOD_NOT_ALLOWED",
        `Use ${[...allowed].join(", ")} for ${path}.`,
        false,
        {
          allow: [...allowed].join(", "),
        },
      );
    throw new ApiError(404, "NOT_FOUND", `No API route matches ${path}.`);
  }
}

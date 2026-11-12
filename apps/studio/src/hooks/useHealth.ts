import type { HealthData } from "@avs/contracts";
import { useEffect, useState } from "react";
import { getHealth } from "../services/api";

export type HealthState =
  { kind: "loading" } | { kind: "ok"; data: HealthData } | { kind: "error"; message: string };

export function useHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((data) => !cancelled && setState({ kind: "ok", data }))
      .catch(
        (e: unknown) =>
          !cancelled &&
          setState({ kind: "error", message: e instanceof Error ? e.message : "Unknown error" }),
      );
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

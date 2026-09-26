import { useCallback, useEffect, useRef, useState } from "react";
import { api, call } from "../../api";
import type { CodeLength } from "../../../shared/codes";
import { onChange } from "../../lib/live";

type ConfigState = { codeLength: CodeLength | null; loading: boolean; error: string };

/** The active deployment-wide code length, shared by every mounted entry surface. */
export function useCodeConfig(): ConfigState & { refetch: () => Promise<CodeLength> } {
  const [state, setState] = useState<ConfigState>({ codeLength: null, loading: true, error: "" });
  const mounted = useRef(false);
  const sequence = useRef(0);

  const refetch = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const response = await call(api.pickup.config);
      const codeLength = response.codeLength;
      if (codeLength !== 4 && codeLength !== 6) throw new Error("Relay returned an unsupported code length.");
      if (mounted.current && current === sequence.current) setState({ codeLength, loading: false, error: "" });
      return codeLength;
    } catch (error) {
      if (mounted.current && current === sequence.current)
        setState((previous) => ({
          ...previous,
          loading: false,
          error: (error as Error)?.message || "Could not load the current code settings.",
        }));
      throw error;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refetch().catch(() => {});
    };
    // Account updates can change the deployment setting; focus/online events cover another tab
    // or another device, and the visible timer catches changes while this surface stays open.
    const offAccount = onChange("account", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("online", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = window.setInterval(refreshWhenVisible, 60_000);
    void refetch().catch(() => {});
    return () => {
      mounted.current = false;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- bumping the counter on unmount is what invalidates in-flight requests.
      sequence.current++;
      offAccount();
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("online", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, [refetch]);

  return { ...state, refetch };
}

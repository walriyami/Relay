import { lazy, type ComponentType } from "react";
import { pageRetries } from "../app/PageBoundary";

/**
 * The address of a page chunk that failed to load. Browsers remember a failed module import for
 * good, so trying again means asking for the same file under a fresh address.
 */
function failedChunk(error: unknown, name: string) {
  const named = /(https?:\/\/\S+?\.js)\b/.exec(error instanceof Error ? error.message : "")?.[1];
  if (named) return named;
  return performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .reverse()
    .find((url) => {
      const path = new URL(url).pathname;
      return path.startsWith(`/assets/${name}-`) && path.endsWith(".js");
    });
}

/** A lazily loaded page whose "Try again" really fetches its chunk again after a failure. */
export function lazyComponent<P extends object>(name: string, load: () => Promise<Record<string, unknown>>) {
  let retry: string | undefined;
  let retrying = false;
  let failedAt: number | undefined;
  const retryLoad = async () => {
    // WebKit need not record an aborted import in Resource Timing. The build's
    // tiny manifest supplies the real hashed URL, without parsing compiled code.
    if (!retry) {
      const response = await fetch("/assets/page-chunks.json", { cache: "no-store" });
      if (!response.ok) throw new Error("The page code could not be loaded.");
      const chunks = (await response.json()) as Record<string, string>;
      retry = chunks[name];
      if (!retry) throw new Error("The page code could not be found.");
    }
    return import(/* @vite-ignore */ `${retry.split("?")[0]}?retry=${Date.now()}`) as Promise<Record<string, unknown>>;
  };
  const make = () =>
    lazy(() =>
      (retrying ? retryLoad() : load()).then(
        (module: Record<string, unknown>) => ({ default: module[name] as ComponentType<P> }),
        (error: unknown) => {
          retry = failedChunk(error, name) ?? retry;
          failedAt = pageRetries();
          throw error;
        },
      ),
    );
  let Loaded = make();
  return (props: P) => {
    // A failed load stays failed until the person asks to try again; only then fetch anew.
    if (failedAt !== undefined && failedAt !== pageRetries()) {
      failedAt = undefined;
      retrying = true;
      Loaded = make();
    }
    return <Loaded {...props} />;
  };
}

import { downloadDirect } from "./local/download";
import { routeFor } from "./local/transport";

/** Starts a download in place, never in a new tab: over the direct connection when it can. */
export function download(url: string, name?: string) {
  if (routeFor("GET", url, true) === "relay") return save(url, name);
  void downloadDirect(url)
    .catch(() => false)
    .then((started) => {
      if (!started) save(url, name);
    });
}

function save(url: string, name?: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name || "";
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
}

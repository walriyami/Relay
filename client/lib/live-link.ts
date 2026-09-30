import { useEffect, useState } from "react";
import { api, type Link } from "../api";
import { useLive } from "./live";

/** Cached/initial absence proves nothing; a successful fresh list can retire a handoff. */
export function useLiveLink(made: Link) {
  const { data, loading, hasLoaded, error } = useLive(api.links.list, {}, ["links", "items"], []);
  const current = data.find((link) => link.id === made.id);
  const [snapshot, setSnapshot] = useState({ id: made.id, link: made, removed: false });
  const known = snapshot.id === made.id ? snapshot : { id: made.id, link: made, removed: false };
  const absent = hasLoaded && !current && !loading && !error;
  useEffect(() => {
    if (!hasLoaded || loading || error) return;
    setSnapshot((previous) => {
      if (current) return { id: made.id, link: current, removed: false };
      if (previous.id !== made.id) return { id: made.id, link: made, removed: true };
      return previous.removed ? previous : { ...previous, removed: true };
    });
  }, [current, made, loading, hasLoaded, error]);
  return {
    link: current ?? known.link,
    removed: known.removed || absent,
  };
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, Clock, Clock3, FolderOpen, RotateCcw, Search, Trash2, X } from "lucide-react";
import { api, call, type ItemPage } from "../../api";
import { useLive, notifyChange } from "../../lib/live";
import { navigate, releaseModalAddress, takeModalAddress, useRoute } from "../../lib/router";
import { CardGrid, CardSkeletons, CollectionCard } from "../../components/CollectionCard";
import {
  Button,
  EmptyState,
  IconButton,
  InlineEmpty,
  LoadFailed,
  Menu,
  confirmDialog,
  dismissToastKey,
  toast,
} from "../../components/ui";
import { undoKey } from "./actions";
import { plural } from "../../lib/format";
import { KEEP_DAYS, days as dayLabel } from "../../lib/options";
import { useSession } from "../../app/session";
import { CollectionModal, itemAddress } from "./CollectionModal";

type Sort = "new" | "old" | "name" | "size";
const SORTS: { value: Sort; label: string }[] = [
  { value: "new", label: "Newest first" },
  { value: "old", label: "Oldest first" },
  { value: "name", label: "Name A–Z" },
  { value: "size", label: "Largest first" },
];

const SORT_KEY = "relay-sort";
function savedSort(): Sort {
  try {
    const value = localStorage.getItem(SORT_KEY);
    return SORTS.find((s) => s.value === value)?.value ?? "new";
  } catch {
    return "new";
  }
}

const RECENT_LIMIT = 12;
const RECENT_ROWS = 2;
const PAGE = 200;
const NO_ITEMS: ItemPage = { items: [], total: 0 };
const NO_SELECTION = new Set<string>();

/** Columns the card grid inside `ref` currently lays out, kept up to date as it resizes. */
function useGridColumns(ref: React.RefObject<HTMLElement | null>, ready: unknown) {
  const [cols, setCols] = useState(5);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      const grid = node.querySelector<HTMLElement>(".card-grid");
      if (!grid) return;
      const tracks = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
      setCols(Math.max(1, tracks));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, ready]);
  return cols;
}

export function RecentGrid() {
  const {
    data: { items: data },
    loading,
    error,
    reload,
  } = useLive(api.items.list, { query: { limit: RECENT_LIMIT } }, ["items", "links"], NO_ITEMS);
  const [open, setOpen] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const cols = useGridColumns(wrap, data.length > 0);
  // Whole rows only, at most two: a ragged last row is shown only when that's everything there is.
  let count = Math.min(data.length, cols * RECENT_ROWS);
  if (count > cols) count -= count % cols;
  return (
    <section className="section" aria-labelledby="recent-title">
      <div className="section-head">
        <h2 id="recent-title">Recent</h2>
        {data.length > 0 && (
          <Button variant="ghost" size="sm" className="section-link" onClick={() => navigate("/files")}>
            View all
          </Button>
        )}
      </div>
      <div ref={wrap}>
        {error && data.length > 0 ? (
          <>
            <LoadFailed banner error={error} onRetry={reload} />
            <CardGrid label="Recent">
              {data.slice(0, count).map((c) => (
                <div role="listitem" key={c.id}>
                  <CollectionCard item={c} onOpen={() => setOpen(c.id)} />
                </div>
              ))}
            </CardGrid>
          </>
        ) : error ? (
          <LoadFailed title="Recent files couldn’t be loaded" error={error} onRetry={reload} />
        ) : loading && !data.length ? (
          <CardSkeletons count={cols} />
        ) : data.length ? (
          <CardGrid label="Recent">
            {data.slice(0, count).map((c) => (
              <div role="listitem" key={c.id}>
                <CollectionCard item={c} onOpen={() => setOpen(c.id)} />
              </div>
            ))}
          </CardGrid>
        ) : (
          <InlineEmpty icon={<Clock3 size={20} />} title="Nothing recent yet">
            Files and text you send or save will appear here.
          </InlineEmpty>
        )}
      </div>
      {open && <CollectionModal id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

const searchParam = () => new URLSearchParams(location.search).get("q") ?? "";

export function FilesPage({ trash = false }: { trash?: boolean }) {
  const page = trash ? "/trash" : "/files";
  const { me } = useSession();
  const [query, setQuery] = useState(searchParam);
  const [debounced, setDebounced] = useState(() => searchParam().trim());
  const [sort, setSort] = useState<Sort>(() => savedSort());
  const [open, setOpen] = useState<string | null>(null);
  // Choosing items for one action is a mode, entered from the toolbar, so cards stay clean otherwise.
  const [selecting, setSelecting] = useState(false);
  const anchor = useRef<number | null>(null);
  const [selectionState, setSelectionState] = useState<{ key: string; ids: Set<string> }>({
    key: "",
    ids: NO_SELECTION,
  });
  const [bulkBusy, setBulkBusy] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const route = useRoute();
  useEffect(() => {
    // Only ids that could exist open a popup; a mistyped address says so and shows the page.
    const id = takeModalAddress(page);
    if (!id) return;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) setOpen(id);
    else {
      releaseModalAddress(page);
      toast(`That address doesn’t point to anything in ${trash ? "Trash" : "Files"}.`);
    }
  }, [route, page, trash]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);
  // The search is kept in the address (?q=), so reload and Back return to the same results.
  useEffect(() => {
    const restore = () => {
      if (location.pathname !== page) return;
      const q = searchParam();
      setQuery(q);
      setDebounced(q.trim());
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [page]);
  useEffect(() => {
    if (location.pathname !== page) return;
    const next = debounced ? `${page}?q=${encodeURIComponent(debounced)}` : page;
    if (location.pathname + location.search !== next) history.replaceState(history.state, "", next);
  }, [debounced, page]);
  // Each request is one stable page; a new view, search or sort starts at page one.
  const listKey = `${trash}|${debounced}|${sort}`;
  const [position, setPosition] = useState({ key: listKey, page: 0 });
  const pageIndex = position.key === listKey ? position.page : 0;
  const pageKey = `${listKey}|${pageIndex}`;
  const {
    data: loaded = NO_ITEMS,
    loading,
    error,
    reload,
  } = useLive(
    api.items.list,
    { query: { view: trash ? "trash" : "library", q: debounced, sort, limit: PAGE, offset: pageIndex * PAGE } },
    ["items", "links"],
    NO_ITEMS,
  );
  const { data: unfilteredTrash = NO_ITEMS } = useLive(
    trash && debounced ? api.items.list : null,
    trash && debounced ? { query: { view: "trash", limit: 1 } } : null,
    ["items"],
    NO_ITEMS,
  );
  const { items: data, total } = loaded;
  const trashTotal = trash && debounced ? unfilteredTrash.total : total;
  const selected =
    selectionState.key === pageKey
      ? new Set([...selectionState.ids].filter((id) => data.some((item) => item.id === id)))
      : NO_SELECTION;
  const pageCount = Math.max(1, Math.ceil(total / PAGE));
  const [emptying, setEmptying] = useState(false);
  const results = useRef<HTMLDivElement>(null);
  const previousPage = useRef(pageIndex);
  const focusResultsOnPageChange = useRef(false);
  useEffect(() => {
    if (previousPage.current !== pageIndex) {
      focusResultsOnPageChange.current = true;
      results.current?.scrollIntoView({ block: "start" });
    }
    previousPage.current = pageIndex;
  }, [pageIndex]);
  useEffect(() => {
    if (!loading && focusResultsOnPageChange.current) {
      const firstItem = results.current?.querySelector<HTMLElement>(".card-open");
      (firstItem ?? results.current)?.focus({ preventScroll: true });
      focusResultsOnPageChange.current = false;
    }
  }, [loading, pageKey]);
  useEffect(() => {
    anchor.current = null;
  }, [pageKey]);
  // An empty view has nothing to choose from.
  useEffect(() => {
    if (!loading && !data.length) setSelecting(false);
  }, [loading, data.length]);
  useEffect(() => {
    if (!loading && !error && pageIndex > 0 && pageIndex * PAGE >= total)
      setPosition({ key: listKey, page: Math.max(0, pageCount - 1) });
  }, [loading, error, pageIndex, total, pageCount, listKey]);
  const clearSearch = () => {
    setQuery("");
    setDebounced("");
    search.current?.focus();
  };
  async function emptyTrash() {
    if (
      !(await confirmDialog({
        title: "Empty Trash?",
        body: debounced
          ? "Everything in Trash will be deleted forever, including items outside this search. This can’t be undone."
          : `${plural(trashTotal, "item")} will be deleted forever. This can’t be undone.`,
        confirm: "Empty Trash",
        danger: true,
      }))
    )
      return;
    setEmptying(true);
    try {
      const { removed } = await call(api.items.emptyTrash);
      dismissToastKey(undoKey(""));
      toast(`Trash emptied · ${plural(removed, "item")} deleted`);
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setEmptying(false);
      notifyChange("items");
    }
  }
  function changePage(next: number) {
    setPosition({ key: listKey, page: next });
    setSelectionState({ key: `${listKey}|${next}`, ids: NO_SELECTION });
  }
  function stopSelecting() {
    setSelecting(false);
    setSelectionState({ key: pageKey, ids: NO_SELECTION });
    anchor.current = null;
  }
  /** Picks or unpicks one card; with `range`, everything from the last one picked takes its new state. */
  function toggleItem(index: number, range: boolean) {
    const on = !selected.has(data[index].id);
    const from = range && anchor.current !== null ? Math.min(anchor.current, index) : index;
    const to = range && anchor.current !== null ? Math.max(anchor.current, index) : index;
    const ids = new Set(selected);
    for (const item of data.slice(from, to + 1)) {
      if (on) ids.add(item.id);
      else ids.delete(item.id);
    }
    anchor.current = index;
    setSelectionState({ key: pageKey, ids });
  }
  function toggleAll() {
    const ids = new Set(selected.size === data.length ? [] : data.map((item) => item.id));
    setSelectionState({ key: pageKey, ids });
  }
  useEffect(() => {
    if (!selecting || open) return;
    const onKey = (event: KeyboardEvent) => {
      // Menus and dialogs close first; typing in a field is left alone.
      if (event.defaultPrevented || document.querySelector("[role=menu], [role=dialog], [role=alertdialog]")) return;
      const typing = (event.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
      if (event.key === "Escape") {
        event.preventDefault();
        stopSelecting();
      } else if (event.key === "a" && (event.metaKey || event.ctrlKey) && !typing) {
        event.preventDefault();
        setSelectionState({ key: pageKey, ids: new Set(data.map((item) => item.id)) });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  async function applyBulk(operation: "trash" | "restore"): Promise<void>;
  async function applyBulk(operation: "retention", keep: number): Promise<void>;
  async function applyBulk(operation: "retention" | "trash" | "restore", keep = 0) {
    const ids = [...selected];
    if (!ids.length) return;
    if (
      operation === "trash" &&
      !(await confirmDialog({
        title: `Move ${plural(ids.length, "item")} to Trash?`,
        body: `${plural(ids.length, "item")} will move to Trash. You can restore them for ${dayLabel(me.user.trashDays)}; their links will stop working.`,
        confirm: "Move to Trash",
        danger: true,
      }))
    )
      return;
    setBulkBusy(true);
    try {
      if (operation === "retention") {
        await call(api.items.bulk, { body: { operation, ids, retentionDays: keep || null } });
      } else {
        await call(api.items.bulk, { body: { operation, ids } });
      }
      for (const id of ids) dismissToastKey(undoKey(id));
      // The action is the end of choosing: back to the plain view.
      stopSelecting();
      notifyChange("items");
      if (operation === "trash") {
        toast(`${plural(ids.length, "item")} moved to Trash`, {
          action: {
            label: "Undo",
            onClick: () =>
              void call(api.items.bulk, { body: { operation: "restore", ids } })
                .then(() => {
                  notifyChange("items");
                  toast(`${plural(ids.length, "item")} restored`, { tone: "success" });
                })
                .catch((e) => toast((e as Error).message, { tone: "error" })),
          },
        });
      } else if (operation === "restore") {
        toast(`${plural(ids.length, "item")} restored`, { tone: "success" });
      } else {
        toast(
          keep
            ? `${plural(ids.length, "item")} will move to Trash in ${dayLabel(keep)}`
            : `${plural(ids.length, "item")} will be kept until you delete ${ids.length === 1 ? "it" : "them"}`,
          { tone: "success" },
        );
      }
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    } finally {
      setBulkBusy(false);
    }
  }
  const nothingHere = !loading && !error && !total && !query && !debounced;
  const allSelected = data.length > 0 && data.every((item) => selected.has(item.id));
  return (
    <div className="page">
      <div className="page-head">
        <div>
          {trash && (
            <a
              className="back-link"
              href="/files"
              onClick={(event) => {
                event.preventDefault();
                navigate("/files");
              }}
            >
              <ArrowLeft size={16} aria-hidden /> Files
            </a>
          )}
          <h1>{trash ? "Trash" : "Files"}</h1>
          <p className="muted">
            {trash
              ? `Items in Trash are deleted forever after ${dayLabel(me.user.trashDays)}. Their links no longer work.`
              : total
                ? debounced
                  ? plural(total, "match", "matches")
                  : plural(total, "item")
                : " "}
          </p>
        </div>
        {/* Files leads to Trash, and Trash back to Files from its heading. */}
        {trash ? (
          trashTotal > 0 && (
            <div className="page-actions">
              <Button className="danger-text" icon={<Trash2 size={16} />} busy={emptying} onClick={emptyTrash}>
                Empty Trash
              </Button>
            </div>
          )
        ) : (
          <div className="page-actions">
            <Button variant="ghost" icon={<Trash2 size={16} />} onClick={() => navigate("/trash")}>
              Trash
            </Button>
          </div>
        )}
      </div>
      {/* Nothing to search or sort until there is something here. */}
      {!nothingHere && (
        <div className="toolbar">
          <label className="search">
            <Search size={16} aria-hidden />
            <input
              ref={search}
              className="input"
              type="search"
              placeholder="Search"
              aria-label={trash ? "Search Trash" : "Search files"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  clearSearch();
                }
              }}
            />
            {query && (
              <IconButton
                className="search-clear"
                size="sm"
                label="Clear search"
                icon={<X size={16} />}
                onClick={clearSearch}
              />
            )}
          </label>
          <select
            className="input select"
            aria-label="Sort"
            value={sort}
            onChange={(e) => {
              const next = e.target.value as Sort;
              setSort(next);
              try {
                localStorage.setItem(SORT_KEY, next);
              } catch {
                // The choice just isn't remembered.
              }
            }}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          {data.length > 0 && (
            <Button
              className="select-toggle"
              variant={selecting ? "primary" : "ghost"}
              icon={selecting ? undefined : <CheckCircle2 size={16} />}
              aria-pressed={selecting}
              onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
            >
              {selecting ? "Done" : "Select"}
            </Button>
          )}
        </div>
      )}
      <div
        className="library-results"
        ref={results}
        role="region"
        aria-label={trash ? "Trash results" : "File results"}
        tabIndex={-1}
      >
        {error && data.length > 0 && <LoadFailed banner error={error} onRetry={reload} />}
        {error && !data.length ? (
          <LoadFailed
            title={trash ? "Trash couldn’t be loaded" : "Files couldn’t be loaded"}
            error={error}
            onRetry={reload}
          />
        ) : loading && !data.length ? (
          <CardSkeletons count={6} />
        ) : data.length ? (
          <>
            <CardGrid label={trash ? "Trash" : "Files"}>
              {data.map((c, index) => (
                <div role="listitem" key={c.id}>
                  <CollectionCard
                    item={c}
                    trash={trash}
                    query={debounced}
                    onOpen={() => setOpen(c.id)}
                    selecting={selecting}
                    selected={selected.has(c.id)}
                    selectionDisabled={bulkBusy}
                    onToggle={(range) => toggleItem(index, range)}
                  />
                </div>
              ))}
            </CardGrid>
            {selecting && (
              <div className="selection-bar" role="toolbar" aria-label="Selected items">
                <span className="selection-count" role="status">
                  {selected.size ? `${selected.size.toLocaleString()} selected` : "Choose items"}
                </span>
                <Button variant="ghost" size="sm" disabled={bulkBusy} onClick={toggleAll}>
                  {allSelected ? "Select none" : "Select all"}
                </Button>
                <div className="selection-actions">
                  {trash ? (
                    <Button
                      size="sm"
                      icon={<RotateCcw size={16} />}
                      busy={bulkBusy}
                      disabled={!selected.size}
                      onClick={() => void applyBulk("restore")}
                    >
                      Restore
                    </Button>
                  ) : selected.size ? (
                    <>
                      <Menu
                        label={`Keep ${plural(selected.size, "item")} for`}
                        variant="secondary"
                        trigger={
                          <>
                            <Clock size={16} aria-hidden /> Keep for…
                          </>
                        }
                        items={KEEP_DAYS.map((d) => ({
                          label: d ? dayLabel(d) : "Until I delete them",
                          onSelect: () => void applyBulk("retention", d),
                        }))}
                      />
                      <Button
                        size="sm"
                        variant="danger"
                        icon={<Trash2 size={16} />}
                        busy={bulkBusy}
                        onClick={() => void applyBulk("trash")}
                      >
                        Move to Trash
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            )}
            {total > PAGE && (
              <div className="list-more">
                <span className="muted" role="status" aria-live="polite">
                  Page {pageIndex + 1} of {pageCount}. Showing{" "}
                  {data.length ? (pageIndex * PAGE + 1).toLocaleString() : 0}–
                  {(pageIndex * PAGE + data.length).toLocaleString()} of {total.toLocaleString()}.
                </span>
                <div className="row">
                  <Button disabled={loading || pageIndex === 0} onClick={() => changePage(pageIndex - 1)}>
                    Previous
                  </Button>
                  <Button disabled={loading || pageIndex + 1 >= pageCount} onClick={() => changePage(pageIndex + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : debounced ? (
          <EmptyState
            icon={<Search size={28} />}
            title="No matches"
            action={<Button onClick={clearSearch}>Clear search</Button>}
          >
            Nothing matches “{debounced}”.
          </EmptyState>
        ) : trash ? (
          <EmptyState icon={<Trash2 size={28} />} title="Trash is empty">
            Anything you delete waits here for {dayLabel(me.user.trashDays)}, so you can restore it.
          </EmptyState>
        ) : (
          <EmptyState
            icon={<FolderOpen size={28} />}
            title="No files yet"
            action={
              <Button variant="primary" onClick={() => navigate("/")}>
                Send or save something
              </Button>
            }
          >
            Files you send, save, or receive through requests appear here.
          </EmptyState>
        )}
      </div>
      {open && <CollectionModal id={open} url={itemAddress(open, trash)} onClose={() => setOpen(null)} />}
    </div>
  );
}

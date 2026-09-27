import { useEffect, useRef, useState } from "react";
import { Ban, ChevronRight, FolderInput, Inbox, Link2, Pencil, Plus, RotateCcw } from "lucide-react";
import { ApiError, api, call, stableId, urls, type UploadRequest } from "../../api";
import type { Body } from "../../../shared/api";
import { DEFAULTS, LIMITS } from "../../../shared/model";
import { ago, bytes, date, plural, until } from "../../lib/format";
import { notifyChange, useLive } from "../../lib/live";
import { takeModalAddress, useRoute } from "../../lib/router";
import { useExpiryClock } from "../../lib/refresh";
import { requestAddress } from "./address";
import { linkOptions } from "../../lib/options";
import {
  Button,
  EmptyState,
  InlineEmpty,
  Field,
  Menu,
  Modal,
  Segmented,
  Spinner,
  confirmDialog,
  toast,
  LoadFailed,
} from "../../components/ui";
import { CollectionModal } from "../library/CollectionModal";
import { LinkDialog } from "../../components/LinkDialog";
import { itemMeta } from "../library/actions";

const requestUrl = (token: string) => urls.requestLink(location.origin, token);

export function RequestsPage() {
  const { data, loading, error, reload } = useLive(api.requests.list, {}, ["requests"], []);
  const [closedShown, setClosedShown] = useState(100);
  const now = useExpiryClock(data.map((r) => r.expires));
  const [creating, setCreating] = useState(false);
  const [sharingRequest, setCreated] = useState<UploadRequest | null>(null);
  // The handoff follows the live request: a request just created may not be listed yet.
  const created = sharingRequest && (data.find((r) => r.id === sharingRequest.id) ?? sharingRequest);
  const createdOpen = !!created && !created.closed && created.expires > now;
  // Closed in another tab, or expired while shown: never offer a dead link or code for copying.
  useEffect(() => {
    if (!created || createdOpen) return;
    setCreated(null);
    toast(created.closed ? "This request was closed." : "This request has expired.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createdOpen]);
  // Follows the live request, so a close from another tab ends the edit instead of failing on Save.
  const [editing, setEditing] = useState<{ id: string; limits: boolean } | null>(null);
  // A request just created may not be listed yet; its share handoff holds it until then.
  const edited =
    editing && (data.find((r) => r.id === editing.id) ?? (created?.id === editing.id ? created : undefined));
  useEffect(() => {
    if (!editing || (edited && !edited.closed)) return;
    setEditing(null);
    // An open share dialog for the same request says so itself.
    if (edited && sharingRequest?.id !== edited.id) toast("This request was closed.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edited?.closed, !!edited]);
  const edit = (r: UploadRequest, limits = false) => setEditing({ id: r.id, limits });
  const [viewingId, setViewingId] = useState<string | null>(null);
  const viewing = viewingId ? (data.find((r) => r.id === viewingId) ?? null) : null;
  const setViewing = (r: UploadRequest | null) => setViewingId(r?.id ?? null);
  // /requests/<id> (a reload, or View on a new-files notice) opens that request's received files.
  const route = useRoute();
  useEffect(() => {
    const id = takeModalAddress("/requests");
    if (id) setViewingId(id);
  }, [route]);
  const open = data.filter((r) => !r.closed && r.expires > now);
  const closed = data.filter((r) => r.closed || r.expires <= now);
  async function close(r: UploadRequest) {
    const ok = await confirmDialog({
      title: `Close “${r.name}”?`,
      body: "People can’t upload with this link anymore. Files already received stay in Files.",
      confirm: "Close request",
      danger: true,
    });
    if (!ok) return;
    try {
      await call(api.requests.close, { params: { id: r.id } });
      notifyChange("requests");
      toast("Request closed");
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }
  const row = (r: UploadRequest, live: boolean) => (
    <li key={r.id} className={`list-row request-row ${live ? "" : "inactive"}`}>
      <span className="list-icon">
        <FolderInput size={18} aria-hidden />
      </span>
      <button type="button" className="list-text" onClick={() => setViewing(r)}>
        <strong>
          {r.name}
          {live && r.full && (
            <>
              {" "}
              <span className="pill" title="Guests can’t upload more">
                Full
              </span>
            </>
          )}
        </strong>
        <span className="muted">
          {[
            r.receivedFiles
              ? `${plural(r.receivedFiles, "file")} · ${bytes(r.receivedBytes)} received`
              : "Nothing received yet",
            live
              ? r.full
                ? "No room for more · raise its limit or close it"
                : `Closes ${until(r.expires)}`
              : r.closed
                ? "Closed"
                : "Expired",
          ].join(" · ")}
        </span>
      </button>
      <ChevronRight className="row-chevron" size={18} aria-hidden />
      {/* A full request takes nothing more until its limit is raised, so that is the next step. */}
      {live && (
        <span className="row-copy">
          {r.full ? (
            <Button size="sm" onClick={() => edit(r, true)}>
              Raise limit
            </Button>
          ) : (
            <Button size="sm" onClick={() => setCreated(r)}>
              Share
            </Button>
          )}
        </span>
      )}
      <Menu
        label={`More actions for ${r.name}`}
        items={[
          { label: "View received files", icon: <Inbox size={16} />, onSelect: () => setViewing(r) },
          ...(live
            ? [
                { label: "Share request", icon: <Link2 size={16} />, onSelect: () => setCreated(r) },
                { label: "Edit request", icon: <Pencil size={16} />, onSelect: () => edit(r) },
                {
                  label: "Close request",
                  icon: <Ban size={16} />,
                  danger: true,
                  separator: true,
                  onSelect: () => void close(r),
                },
              ]
            : r.closed
              ? []
              : [{ label: "Reopen request", icon: <RotateCcw size={16} />, onSelect: () => edit(r) }]),
        ]}
      />
    </li>
  );
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Requests</h1>
          <p className="muted">Collect files from anyone with a link. They don’t need an account.</p>
        </div>
        {data.length > 0 && (
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
            New request
          </Button>
        )}
      </div>
      {error && data.length > 0 && <LoadFailed banner error={error} onRetry={reload} />}
      {error && !data.length ? (
        <LoadFailed title="Requests couldn’t be loaded" error={error} onRetry={reload} />
      ) : loading && !data.length ? (
        <Spinner />
      ) : !data.length ? (
        <EmptyState
          icon={<FolderInput size={28} />}
          title="No requests yet"
          action={
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
              New request
            </Button>
          }
        >
          Ask someone for files and they’ll land straight in your Files.
        </EmptyState>
      ) : (
        <>
          {open.length > 0 && (
            <ul className="list card-surface" aria-label="Open requests">
              {open.map((r) => row(r, true))}
            </ul>
          )}
          {!open.length && (
            <InlineEmpty icon={<FolderInput size={20} />} title="No open requests">
              Create a request when you need files from someone.
            </InlineEmpty>
          )}
          {closed.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2>Closed</h2>
              </div>
              <ul className="list card-surface" aria-label="Closed requests">
                {closed.slice(0, closedShown).map((r) => row(r, false))}
              </ul>
              {closed.length > closedShown && (
                <div className="list-more">
                  <span className="muted">
                    Showing {closedShown} of {closed.length}
                  </span>
                  <Button onClick={() => setClosedShown((n) => n + 100)}>Show more closed requests</Button>
                </div>
              )}
            </section>
          )}
        </>
      )}
      {creating && (
        <CreateRequest
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            setCreated(r);
          }}
        />
      )}
      {created && createdOpen && (
        <LinkDialog
          title={created.name}
          subtitle="Share this link with the people who should upload."
          meta={`Up to ${bytes(created.maxBytes)} · Closes ${until(created.expires)}`}
          url={requestUrl(created.token)}
          code={created.code}
          codeLabel="Upload code"
          purpose="upload request"
          actions={
            <Button size="sm" variant="ghost" icon={<Pencil size={16} />} onClick={() => edit(created)}>
              Edit request
            </Button>
          }
          onClose={() => setCreated(null)}
        />
      )}
      {edited && !edited.closed && (
        <EditRequest request={edited} limitsOpen={editing.limits} onClose={() => setEditing(null)} />
      )}
      {viewing && <Submissions request={viewing} onEdit={() => edit(viewing)} onClose={() => setViewing(null)} />}
    </div>
  );
}

type NewRequest = Omit<Body<typeof api.requests.create>, "id">;
type Settings = Omit<Body<typeof api.requests.update>, "days"> & { days: number | null };

const GB = 1024 ** 3;
const DAY = 86_400_000;
const EMPTY_NAME = "Say what you’re asking for, for example “Wedding photos”.";
/** A size as the GB field shows it: at most two decimals, or three significant digits below 0.01 GB. */
const gbText = (n: number) =>
  String(n >= GB / 100 ? Math.round((n / GB) * 100) / 100 : Number((n / GB).toPrecision(3)));

/**
 * Retrying the same form reuses its id, so a lost response never creates a second request. A 409
 * means that id already names a different request; start over once with a fresh id.
 */
async function createRequest(input: NewRequest, retried = false): Promise<UploadRequest> {
  const key = stableId(`request:${JSON.stringify(input)}`);
  try {
    const request = await call(api.requests.create, { body: { id: key.id, ...input } });
    key.forget();
    return request;
  } catch (e) {
    if (retried || !(e instanceof ApiError && e.status === 409)) throw e;
    key.forget();
    return createRequest(input, true);
  }
}

/**
 * The one form behind New request and Edit request. `request` is the request being edited: its
 * closing time is shown as a date until a new duration is chosen, counted from now, and its size
 * limit can't go below what it already holds.
 */
function RequestForm({
  id,
  request,
  limitsOpen = false,
  onSubmit,
}: {
  id: string;
  request?: UploadRequest;
  limitsOpen?: boolean;
  onSubmit: (settings: Settings) => Promise<void>;
}) {
  const expired = !!request && request.expires <= Date.now();
  const [name, setName] = useState(request?.name ?? "");
  const [description, setDescription] = useState(request?.description ?? "");
  // An open request keeps its closing time until a duration is chosen; a new or expired one needs one.
  const [days, setDays] = useState<number | null>(request && !expired ? null : DEFAULTS.linkDays);
  const initialGb = request ? gbText(request.maxBytes) : "10";
  const [gb, setGb] = useState(initialGb);
  const [limits, setLimits] = useState(limitsOpen);
  const [error, setError] = useState<{ field: "name" | "size" | null; message: string } | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const sizeField = useRef<HTMLInputElement>(null);
  const held = request?.usedBytes ?? 0;
  const maxBytes = gb === initialGb && request ? request.maxBytes : Math.round(Number(gb) * GB);
  const sizeHint = held > 0 ? `Already holds ${bytes(held)}.` : undefined;
  const closing =
    days === null
      ? `Closes ${date(request!.expires)} (${until(request!.expires)}).`
      : `${expired ? "Open until" : "Closes"} ${date(Date.now() + days * DAY)}${request ? ", counted from now" : ""}.`;
  function fail(field: "name" | "size" | null, message: string) {
    setError({ field, message });
    if (field === "size") setLimits(true);
    // After the size field has rendered.
    setTimeout(() => (field === "name" ? nameField : field === "size" ? sizeField : null)?.current?.focus());
  }
  const errorId = `${id}-error`;
  const described = (field: "name" | "size") => (error?.field === field ? errorId : undefined);
  return (
    <form
      id={id}
      className="stack"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim()) return fail("name", EMPTY_NAME);
        if (!(maxBytes >= 1) || Number(gb) > 1024)
          return fail("size", "Enter a size limit above 0 and up to 1,024 GB.");
        if (maxBytes < held) return fail("size", `This request already holds ${bytes(held)}. Choose at least that.`);
        setError(null);
        try {
          await onSubmit({ name: name.trim(), description: description.trim(), days, maxBytes });
        } catch (e) {
          fail(null, (e as Error).message);
        }
      }}
    >
      <Field label="What are you asking for?">
        <input
          ref={nameField}
          className="input"
          required
          maxLength={LIMITS.nameLength}
          placeholder="e.g. Wedding photos"
          value={name}
          aria-invalid={error?.field === "name" || undefined}
          aria-describedby={described("name")}
          onChange={(e) => {
            setName(e.target.value);
            if (error?.field === "name") setError(null);
          }}
          data-autofocus={!limitsOpen || undefined}
        />
      </Field>
      <Field label="Message (optional)" hint="Shown on the upload page.">
        <textarea
          className="input"
          rows={3}
          maxLength={LIMITS.requestMessageLength}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="stack-sm">
        <span className="field-label">Stays open for</span>
        <Segmented label="Stays open for" value={days ?? -1} options={linkOptions()} onChange={setDays} />
        <p className="field-hint">{closing}</p>
      </div>
      {!limits ? (
        <p className="limits-summary muted">
          Size limit: {bytes(maxBytes)}
          {held > 0 && ` · ${bytes(held)} used`} ·{" "}
          <button type="button" className="link" onClick={() => setLimits(true)}>
            Change
          </button>
        </p>
      ) : (
        <Field label="Total size limit (GB)" hint={sizeHint}>
          <input
            ref={sizeField}
            className="input"
            type="number"
            inputMode="decimal"
            min={0}
            max={1024}
            step="any"
            required
            value={gb}
            aria-invalid={error?.field === "size" || undefined}
            aria-describedby={described("size")}
            data-autofocus={limitsOpen || undefined}
            onChange={(e) => {
              setGb(e.target.value);
              if (error?.field === "size") setError(null);
            }}
          />
        </Field>
      )}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error.message}
        </p>
      )}
    </form>
  );
}

function CreateRequest({ onClose, onCreated }: { onClose: () => void; onCreated: (r: UploadRequest) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="New request"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="create-request" busy={busy}>
            Create request
          </Button>
        </>
      }
    >
      <RequestForm
        id="create-request"
        onSubmit={async ({ days, ...settings }) => {
          setBusy(true);
          try {
            const request = await createRequest({ ...settings, days: days ?? DEFAULTS.linkDays });
            notifyChange("requests");
            onCreated(request);
          } finally {
            setBusy(false);
          }
        }}
      />
    </Modal>
  );
}

/** Edits an open request in place, or reopens an expired one; its link, code and received files stay. */
function EditRequest({
  request,
  limitsOpen,
  onClose,
}: {
  request: UploadRequest;
  limitsOpen: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const expired = request.expires <= Date.now();
  return (
    <Modal
      title={expired ? "Reopen request" : "Edit request"}
      subtitle={expired ? "The same link and code work again." : "The link and code stay the same."}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="edit-request" busy={busy}>
            {expired ? "Reopen request" : "Save"}
          </Button>
        </>
      }
    >
      <RequestForm
        id="edit-request"
        request={request}
        limitsOpen={limitsOpen}
        onSubmit={async (settings) => {
          const unchanged =
            settings.days === null &&
            settings.name === request.name &&
            settings.description === request.description &&
            settings.maxBytes === request.maxBytes;
          if (unchanged) return onClose();
          setBusy(true);
          try {
            await call(api.requests.update, { params: { id: request.id }, body: settings });
            notifyChange("requests");
            onClose();
            toast(expired ? "Request reopened" : "Request updated");
          } finally {
            setBusy(false);
          }
        }}
      />
    </Modal>
  );
}

function Submissions({
  request,
  onEdit,
  onClose,
}: {
  request: UploadRequest;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { data, loading, error, reload } = useLive(
    api.requests.submissions,
    { params: { id: request.id } },
    ["items"],
    [],
  );
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Modal
      title={request.name}
      subtitle={request.full && !request.closed ? "Received files · Full" : "Received files"}
      url={requestAddress(request.id)}
      onClose={onClose}
      actions={
        !request.closed && (
          <Button size="sm" variant="ghost" icon={<Pencil size={16} />} onClick={onEdit}>
            {request.expires <= Date.now() ? "Reopen" : "Edit"}
          </Button>
        )
      }
    >
      {error && !data.length ? (
        <LoadFailed title="Received files couldn’t be loaded" error={error} onRetry={reload} />
      ) : loading && !data.length ? (
        <Spinner />
      ) : !data.length ? (
        <InlineEmpty icon={<Inbox size={20} />} title="No files received yet">
          Files uploaded with this request will appear here and in Files.
        </InlineEmpty>
      ) : (
        <ul className="list submission-list">
          {data.map((s) => (
            <li key={s.id}>
              <button type="button" className="list-row submission-row" onClick={() => setOpen(s.id)}>
                <span className="list-text">
                  <strong>{s.name}</strong>
                  <span className="muted">
                    {[
                      s.sender ? `From ${s.sender}` : "",
                      itemMeta(s),
                      bytes(s.bytes),
                      s.uploading ? "Uploading…" : `Received ${ago(s.created)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <ChevronRight size={18} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <CollectionModal id={open} onClose={() => setOpen(null)} />}
    </Modal>
  );
}

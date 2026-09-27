// First start: welcome, the administrator's account, what members get, an invitation, done.
// The steps after the account can be left and resumed: the server remembers setup is unfinished.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  FolderOpen,
  HardDrive,
  Link2,
  Send,
  Smartphone,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { ApiError, api, call, type Me, type MemberDefaults, type SetupState } from "../../api";
import { bytes, dateTime } from "../../lib/format";
import { fromSegment, keepOptions, linkLifeOptions, toSegment, trashOptions } from "../../lib/options";
import { scrollMotion } from "../../lib/router";
import { Brand } from "../../app/Brand";
import { Button, Segmented, Spinner } from "../../components/ui";
import { ShareAccess } from "../../components/ShareAccess";
import { AccountForm } from "../auth/Auth";
import { browserName } from "../auth/device-name";
import { ByteSizeField, fromDraft, toDraft, type ByteDraft } from "../admin/ByteSize";

type Step = "welcome" | "account" | "members" | "invite" | "done";
/** The steps that ask something, shown as progress. Welcome and done frame them. */
const PROGRESS: { step: Step; label: string }[] = [
  { step: "account", label: "Your account" },
  { step: "members", label: "What everyone gets" },
  { step: "invite", label: "Invite people" },
];

export function Setup({
  state,
  onSignedIn,
  onFinished,
}: {
  /** Where setup stands when this screen opens; read once. */
  state: Exclude<SetupState, "done">;
  onSignedIn: (me: Me) => void;
  /** Leaves setup for the app, or for sign-in when someone else set Relay up first. */
  onFinished: () => void;
}) {
  const [resumed] = useState(state === "defaults");
  const [step, setStep] = useState<Step>(state === "account" ? "welcome" : "members");
  const [claimed, setClaimed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // Each new step is announced by moving focus to its heading; the account step starts typing instead.
    if (first.current) {
      first.current = false;
      if (step !== "welcome") return;
    }
    if (step !== "account") heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [step, claimed]);

  let content: ReactNode;
  if (claimed)
    content = (
      <>
        <h1 id="setup-title" ref={heading} tabIndex={-1}>
          Relay is already set up
        </h1>
        <p className="setup-lead">
          Someone finished setting up Relay a moment ago. Sign in with the account they created, or ask them for an
          invitation.
        </p>
        <div className="setup-actions">
          <Button variant="primary" onClick={onFinished}>
            Go to sign in
          </Button>
        </div>
      </>
    );
  else
    switch (step) {
      case "welcome":
        content = <Welcome heading={heading} onStart={() => setStep("account")} />;
        break;
      case "account":
        content = (
          <AccountStep
            heading={heading}
            onBack={() => setStep("welcome")}
            onCreated={(me) => {
              onSignedIn(me);
              setStep("members");
            }}
            onClaimed={() => setClaimed(true)}
          />
        );
        break;
      case "members":
        content = <MembersStep heading={heading} resumed={resumed} onSaved={() => setStep("invite")} />;
        break;
      case "invite":
        content = <InviteStep heading={heading} onNext={() => setStep("done")} />;
        break;
      case "done":
        content = <Done heading={heading} onFinish={onFinished} />;
        break;
    }
  const current = PROGRESS.findIndex((p) => p.step === step);
  return (
    <main className="setup" tabIndex={-1}>
      <div className="setup-glow" aria-hidden />
      <header className="setup-head">
        <Brand />
        {current >= 0 && !claimed && <Progress current={current} />}
      </header>
      <div className="setup-body">
        {/* Keyed so every step enters with its own animation. */}
        <section
          key={claimed ? "claimed" : step}
          className={`setup-step setup-step-${step}`}
          aria-labelledby="setup-title"
        >
          {content}
        </section>
      </div>
    </main>
  );
}

function Progress({ current }: { current: number }) {
  return (
    <div className="setup-progress">
      <p className="setup-progress-count" aria-hidden>
        Step {current + 1} of {PROGRESS.length}
      </p>
      <ol aria-label="Setup steps">
        {PROGRESS.map((p, i) => (
          <li
            key={p.step}
            className={i < current ? "done" : i === current ? "current" : ""}
            aria-current={i === current ? "step" : undefined}
          >
            <span className="setup-progress-bar" aria-hidden />
            <span className="setup-progress-label">
              {p.label}
              {i < current && <span className="visually-hidden"> (done)</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

type HeadingRef = React.RefObject<HTMLHeadingElement | null>;

function Welcome({ heading, onStart }: { heading: HeadingRef; onStart: () => void }) {
  return (
    <>
      <RelayScene />
      <h1 id="setup-title" ref={heading} tabIndex={-1}>
        Welcome to Relay
      </h1>
      <p className="setup-lead">
        Your own place to move files between your devices and share them with the people you choose.
      </p>
      <ul className="setup-points">
        <Point icon={<Smartphone size={18} />} title="Send to any of your devices">
          Files go straight to your phone, laptop or tablet.
        </Point>
        <Point icon={<Link2 size={18} />} title="Share with a link or a code">
          Anyone can download what you share. No account needed.
        </Point>
        <Point icon={<HardDrive size={18} />} title="Kept on your own server">
          Your files stay here, with you.
        </Point>
      </ul>
      <div className="setup-actions">
        <Button variant="primary" className="setup-cta" onClick={onStart}>
          Get started
          <ArrowRight size={16} aria-hidden />
        </Button>
        <p className="setup-aside">Takes about a minute. You can change everything later.</p>
      </div>
    </>
  );
}

function Point({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li>
      <span className="setup-point-icon" aria-hidden>
        {icon}
      </span>
      <span>
        <strong>{title}</strong>
        <span className="muted">{children}</span>
      </span>
    </li>
  );
}

function AccountStep({
  heading,
  onBack,
  onCreated,
  onClaimed,
}: {
  heading: HeadingRef;
  onBack: () => void;
  onCreated: (me: Me) => void;
  onClaimed: () => void;
}) {
  return (
    <>
      <button type="button" className="setup-back link" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden /> Back
      </button>
      <h1 id="setup-title" ref={heading} tabIndex={-1}>
        Create your account
      </h1>
      <p className="setup-lead">
        You’ll be Relay’s administrator: the one who invites people and looks after it. You can add a name, a passkey
        and your other devices later.
      </p>
      <div className="setup-card card-surface">
        <AccountForm
          id="setup"
          submitLabel="Create account"
          create={async (account) =>
            onCreated(await call(api.setup.account, { body: { ...account, deviceName: browserName() } }))
          }
          onError={(e) => {
            // No account exists while this step shows, so a conflict means someone else got there first.
            if (!(e instanceof ApiError && e.status === 409)) return false;
            onClaimed();
            return true;
          }}
        />
      </div>
    </>
  );
}

const GB = 1024 ** 3;
const OTHER = -1;
const QUOTA_PRESETS = [10 * GB, 50 * GB, 100 * GB, 500 * GB];

/** Most of the disk's free space, rounded down to a figure that reads at a glance. */
function suggestedCapacity(free: number) {
  const usable = free * 0.9;
  if (usable < GB) return Math.max(1, Math.floor(usable / 1024 ** 2)) * 1024 ** 2;
  const gb = Math.floor(usable / GB);
  const step = gb >= 1000 ? 100 : gb >= 100 ? 10 : 1;
  return Math.floor(gb / step) * step * GB;
}

type Choices = { overview: { defaults: MemberDefaults; diskFree: number }; capacity: number };

function MembersStep({ heading, resumed, onSaved }: { heading: HeadingRef; resumed: boolean; onSaved: () => void }) {
  const [loaded, setLoaded] = useState<Choices | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    call(api.admin.overview)
      .then((o) => {
        if (!live) return;
        setLoaded({
          overview: { defaults: o.defaults, diskFree: o.storage.diskFree },
          capacity: suggestedCapacity(o.storage.diskFree),
        });
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [attempt]);
  return (
    <>
      {resumed && (
        <p className="setup-welcome-back" role="status">
          <Check size={16} aria-hidden /> Welcome back. Your account is ready; a few choices are left.
        </p>
      )}
      <h1 id="setup-title" ref={heading} tabIndex={-1}>
        What everyone gets
      </h1>
      <p className="setup-lead">
        Good starting points for everyone who joins, you included. You can change them for anyone, at any time, in
        Admin.
      </p>
      {loaded ? (
        <MembersForm choices={loaded} onSaved={onSaved} />
      ) : error ? (
        <div className="setup-card card-surface stack-sm" role="alert">
          <p>{error}</p>
          <div>
            <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
          </div>
        </div>
      ) : (
        <div className="setup-card card-surface">
          <Spinner label="Loading" />
        </div>
      )}
    </>
  );
}

function MembersForm({ choices, onSaved }: { choices: Choices; onSaved: () => void }) {
  const { defaults, diskFree } = choices.overview;
  const [capacityDraft, setCapacityDraft] = useState<ByteDraft>(() => toDraft(choices.capacity));
  const [editingCapacity, setEditingCapacity] = useState(false);
  const capacity = fromDraft(capacityDraft);
  // The built-in space per person can be more than a small disk holds; start from what fits.
  const [quotaChoice, setQuotaChoice] = useState(() => {
    const fits =
      defaults.quota <= choices.capacity ? defaults.quota : QUOTA_PRESETS.findLast((p) => p <= choices.capacity);
    return fits === undefined ? OTHER : QUOTA_PRESETS.includes(fits) ? fits : OTHER;
  });
  const [quotaDraft, setQuotaDraft] = useState<ByteDraft>(() => toDraft(Math.min(defaults.quota, choices.capacity)));
  const quota = quotaChoice === OTHER ? fromDraft(quotaDraft) : quotaChoice;
  const [retention, setRetention] = useState(defaults.retentionDays ?? 0);
  const [linkDays, setLinkDays] = useState(toSegment(defaults.linkDays));
  const [trashDays, setTrashDays] = useState(defaults.trashDays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const custom = useRef<HTMLDivElement>(null);
  const capacityField = useRef<HTMLDivElement>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (quota === null) {
      custom.current?.querySelector("input")?.focus();
      return setError("Enter the space for each person, more than zero.");
    }
    if (capacity === null) {
      setEditingCapacity(true);
      capacityField.current?.querySelector("input")?.focus();
      return setError("Enter a total for everyone, more than zero.");
    }
    setBusy(true);
    try {
      await call(api.setup.finish, {
        body: { quota, retentionDays: retention || null, linkDays: fromSegment(linkDays), trashDays, capacity },
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="setup-card card-surface setup-questions" noValidate onSubmit={save}>
      <Question
        icon={<HardDrive size={18} />}
        title="Space for each person"
        hint="The most one person can keep in Relay."
      >
        <Segmented
          label="Space for each person"
          value={quotaChoice}
          options={[
            ...QUOTA_PRESETS.map((value) => ({ value, label: bytes(value) })),
            { value: OTHER, label: "Other" },
          ]}
          onChange={(value) => {
            if (value === OTHER && quotaChoice !== OTHER) {
              setQuotaDraft(toDraft(quotaChoice));
              setTimeout(() => custom.current?.querySelector("input")?.focus());
            }
            setQuotaChoice(value);
          }}
        />
        {quotaChoice === OTHER && (
          <div ref={custom} className="setup-reveal">
            <ByteSizeField
              label="Space for each person"
              draft={quotaDraft}
              onChange={setQuotaDraft}
              invalid={quota === null}
            />
          </div>
        )}
      </Question>
      <Question
        icon={<Clock size={18} />}
        title="Keep uploads"
        hint="Uploads older than this move to Trash. People can choose their own in Settings."
      >
        <Segmented label="Keep uploads" value={retention} options={keepOptions(retention)} onChange={setRetention} />
      </Question>
      <Question
        icon={<Link2 size={18} />}
        title="Share links work for"
        hint="Unless the person sharing picks something else for that link."
      >
        <Segmented
          label="Share links work for"
          value={linkDays}
          options={linkLifeOptions(fromSegment(linkDays))}
          onChange={setLinkDays}
        />
      </Question>
      <Question
        icon={<Trash2 size={18} />}
        title="Empty Trash after"
        hint="Until then, anything deleted can be restored."
      >
        <Segmented
          label="Empty Trash after"
          value={trashDays}
          options={trashOptions(trashDays)}
          onChange={setTrashDays}
        />
      </Question>

      <div className="setup-total">
        <span className="setup-question-icon" aria-hidden>
          <Users size={18} />
        </span>
        {editingCapacity ? (
          <div ref={capacityField} className="setup-reveal setup-total-edit">
            <ByteSizeField
              label="Total for everyone"
              hint={`${bytes(diskFree)} is free on this disk.`}
              draft={capacityDraft}
              onChange={setCapacityDraft}
              invalid={capacity === null}
            />
          </div>
        ) : (
          <p className="setup-total-text">
            <strong>Everyone together can use up to {capacity === null ? "…" : bytes(capacity)}</strong>
            <span className="muted">That’s most of the {bytes(diskFree)} free on this disk.</span>
          </p>
        )}
        {!editingCapacity && (
          <Button
            size="sm"
            variant="ghost"
            aria-label="Change the total for everyone"
            onClick={() => {
              setEditingCapacity(true);
              setTimeout(() => capacityField.current?.querySelector("input")?.focus());
            }}
          >
            Change
          </Button>
        )}
      </div>
      {capacity !== null && capacity > diskFree && (
        <p className="notice" role="status">
          That’s more than the {bytes(diskFree)} free on this disk. Uploads will stop when the disk is full.
        </p>
      )}

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="setup-cta" busy={busy}>
        Save and continue
      </Button>
    </form>
  );
}

function Question({
  icon,
  title,
  hint,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="setup-question">
      <span className="setup-question-icon" aria-hidden>
        {icon}
      </span>
      <div className="setup-question-body">
        <span className="setup-question-title">{title}</span>
        {children}
        <span className="field-hint">{hint}</span>
      </div>
    </div>
  );
}

type Invitation = { token: string; code: string; expires: number };

function InviteStep({ heading, onNext }: { heading: HeadingRef; onNext: () => void }) {
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const invite = invites.at(-1);
  const card = useRef<HTMLDivElement>(null);
  // A new invitation opens below the fold on most screens.
  useEffect(() => {
    card.current?.scrollIntoView({ behavior: scrollMotion(), block: "nearest" });
  }, [invite?.token]);
  async function create() {
    setBusy(true);
    setError("");
    try {
      const created = await call(api.admin.invite, { body: {} });
      setInvites((all) => [...all, created]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PeopleScene />
      <h1 id="setup-title" ref={heading} tabIndex={-1}>
        Bring your people in
      </h1>
      <p className="setup-lead">
        Relay is better together. Invite family, friends or teammates: each person gets their own space to send files
        between their devices and share them.
      </p>
      {invite ? (
        <div className="setup-card card-surface setup-invite" key={invite.token} ref={card}>
          <p className="setup-invite-title" role="status">
            <Check size={16} aria-hidden />
            {invites.length === 1 ? "Your invitation is ready" : `Invitation ${invites.length} is ready`}
          </p>
          <ShareAccess
            url={`${location.origin}/join/${invite.token}`}
            code={invite.code}
            codeLabel="Invitation code"
            purpose="invitation"
            detail={`Works once, until ${dateTime(invite.expires)}. The link can’t be shown again after you leave this page; the code stays listed in Admin.`}
          />
        </div>
      ) : null}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="setup-actions">
        {invite ? (
          <>
            <Button variant="primary" className="setup-cta" onClick={onNext}>
              Continue
              <ArrowRight size={16} aria-hidden />
            </Button>
            <Button variant="ghost" icon={<UserPlus size={16} />} busy={busy} onClick={() => void create()}>
              Invite someone else
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              className="setup-cta"
              icon={<UserPlus size={16} />}
              busy={busy}
              onClick={() => void create()}
            >
              Create an invitation
            </Button>
            <Button variant="ghost" onClick={onNext}>
              I’ll do this later
            </Button>
          </>
        )}
        <p className="setup-aside">You can invite more people any time from Admin.</p>
      </div>
    </>
  );
}

function Done({ heading, onFinish }: { heading: HeadingRef; onFinish: () => void }) {
  return (
    <>
      <DoneScene />
      <h1 id="setup-title" ref={heading} tabIndex={-1}>
        You’re all set
      </h1>
      <p className="setup-lead">Relay is ready. Here are a few good first steps.</p>
      <ul className="setup-points">
        <Point icon={<Send size={18} />} title="Send your first file">
          Drop anything on the Send page, then choose a device or a link.
        </Point>
        <Point icon={<Smartphone size={18} />} title="Add your phone">
          Choose Add a device on the Send page, then scan the code with your phone.
        </Point>
        <Point icon={<FolderOpen size={18} />} title="Find everything in Files">
          What you send is kept there, ready to share again.
        </Point>
      </ul>
      <div className="setup-actions">
        <Button variant="primary" className="setup-cta" onClick={onFinish}>
          Start using Relay
          <ArrowRight size={16} aria-hidden />
        </Button>
      </div>
    </>
  );
}

/** A file travelling from a laptop to a phone, over and over. */
function RelayScene() {
  return (
    <svg className="setup-scene scene-relay" viewBox="0 0 320 140" aria-hidden>
      <path className="scene-arc" d="M118 64 Q177 4 236 64" />
      <g className="scene-device">
        <rect x="22" y="38" width="92" height="60" rx="7" />
        <path d="M10 104h116l-6 8H16z" />
        <rect className="scene-line" x="34" y="52" width="40" height="5" rx="2.5" />
        <rect className="scene-line" x="34" y="63" width="62" height="5" rx="2.5" />
        <rect className="scene-line" x="34" y="74" width="28" height="5" rx="2.5" />
      </g>
      <g className="scene-device scene-phone">
        <rect x="238" y="30" width="50" height="86" rx="10" />
        <rect className="scene-line" x="256" y="37" width="14" height="3" rx="1.5" />
        <rect className="scene-landed" x="248" y="52" width="30" height="36" rx="5" />
        <path className="scene-landed-check" d="M256 70l5 5 9-10" />
      </g>
      <circle className="scene-ping" cx="263" cy="70" r="30" />
      <g className="scene-file-x">
        <g className="scene-file-y">
          <g className="scene-file">
            <path d="M-9-12h11l7 7v17a2 2 0 0 1-2 2H-9a2 2 0 0 1-2-2v-22a2 2 0 0 1 2-2z" />
            <path className="scene-file-fold" d="M2-12v7h7" />
          </g>
        </g>
      </g>
    </svg>
  );
}

const PEOPLE = [
  { x: 58, y: 48, tint: "a" },
  { x: 46, y: 116, tint: "b" },
  { x: 262, y: 40, tint: "c" },
  { x: 274, y: 110, tint: "a" },
  { x: 160, y: 142, tint: "c" },
];

/** People appearing around Relay, joined to it one by one. */
function PeopleScene() {
  return (
    <svg className="setup-scene scene-people" viewBox="0 0 320 168" aria-hidden>
      {PEOPLE.map((p, i) => (
        <line
          key={`l${i}`}
          className="scene-tie"
          x1="160"
          y1="78"
          x2={p.x}
          y2={p.y}
          style={{ "--i": i } as React.CSSProperties}
        />
      ))}
      <circle className="scene-ping" cx="160" cy="78" r="30" />
      <g className="scene-hub">
        <rect x="136" y="54" width="48" height="48" rx="12" />
        <path d="M148 70h20m-6-6 6 6-6 6M172 86h-20m6 6-6-6 6-6" />
      </g>
      {PEOPLE.map((p, i) => (
        <g key={`p${i}`} className="scene-person-at" transform={`translate(${p.x} ${p.y})`}>
          <g className={`scene-person tint-${p.tint}`} style={{ "--i": i } as React.CSSProperties}>
            <circle r="17" />
            <circle className="scene-person-glyph" cy="-4" r="5" />
            <path className="scene-person-glyph" d="M-8 9a8 7 0 0 1 16 0z" />
          </g>
        </g>
      ))}
    </svg>
  );
}

/** A check drawn once, with a small burst around it. */
function DoneScene() {
  return (
    <svg className="setup-scene scene-done" viewBox="0 0 160 120" aria-hidden>
      {Array.from({ length: 10 }, (_, i) => (
        <circle
          key={i}
          className="scene-spark"
          cx="80"
          cy="60"
          r={i % 2 ? 2.5 : 3.5}
          style={{ "--a": `${i * 36}deg` } as React.CSSProperties}
        />
      ))}
      <circle className="scene-done-ring" cx="80" cy="60" r="32" />
      <path className="scene-done-check" d="M66 61l10 10 19-21" />
    </svg>
  );
}

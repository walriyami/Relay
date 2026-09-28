// First start: welcome, the administrator's account, their own choices and how much Relay may
// store, their devices, an invitation, done. The steps after the account can be left and resumed:
// the server remembers setup is unfinished until the choices are saved.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, FolderOpen, HardDrive, Link2, Send, Smartphone, UserPlus } from "lucide-react";
import { ApiError, api, call, type Me, type SetupState } from "../../api";
import type { SetMe } from "../../app/session";
import { bytes, dateTime } from "../../lib/format";
import { scrollMotion } from "../../lib/router";
import { Button, Field, Spinner } from "../../components/ui";
import { ShareAccess } from "../../components/ShareAccess";
import { AccountForm } from "../auth/Auth";
import { thisDevice } from "../auth/device-name";
import { ByteSizeField, fromDraft, toDraft, type ByteDraft } from "../admin/ByteSize";
import { DevicesStep } from "./DevicesStep";
import { DoneScene, PeopleScene, RelayScene } from "./scenes";
import { Point, StepTitle, Walkthrough } from "./Walkthrough";
import { YoursStep } from "./YoursStep";

type Step = "welcome" | "account" | "yours" | "devices" | "invite" | "done";
/** The steps that ask something, shown as progress. Welcome and done frame them. */
const PROGRESS: { step: Step; label: string }[] = [
  { step: "account", label: "Your account" },
  { step: "yours", label: "Make it yours" },
  { step: "devices", label: "Your devices" },
  { step: "invite", label: "Invite people" },
];

export function Setup({
  state,
  keyRequired,
  me,
  setMe,
  onSignedIn,
  onFinished,
}: {
  /** Where setup stands when this screen opens; read once. */
  state: Exclude<SetupState, "done">;
  /** The server was started with RELAY_SETUP_KEY, so creating the account needs its one-time key. */
  keyRequired: boolean;
  /** The administrator, once their account exists. */
  me: Me | null;
  setMe: SetMe;
  onSignedIn: (me: Me) => void;
  /** Leaves setup for the app, or for sign-in when someone else set Relay up first. */
  onFinished: () => void;
}) {
  const [resumed] = useState(state === "choices");
  const [step, setStep] = useState<Step>(state === "account" ? "welcome" : "yours");
  const [claimed, setClaimed] = useState(false);
  const [devicesAdded, setDevicesAdded] = useState(0);

  let content: ReactNode;
  if (claimed)
    content = (
      <>
        <StepTitle>Relay is already set up</StepTitle>
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
  else if (step === "welcome" || !me)
    content =
      step === "account" ? (
        <AccountStep
          keyRequired={keyRequired}
          onBack={() => setStep("welcome")}
          onCreated={(created) => {
            onSignedIn(created);
            setStep("yours");
          }}
          onClaimed={() => setClaimed(true)}
        />
      ) : (
        <Welcome onStart={() => setStep("account")} />
      );
  else
    switch (step) {
      case "devices":
        content = (
          <DevicesStep
            onAdded={() => setDevicesAdded((n) => n + 1)}
            added={devicesAdded}
            onNext={() => setStep("invite")}
          />
        );
        break;
      case "invite":
        content = <InviteStep onNext={() => setStep("done")} />;
        break;
      case "done":
        content = <Done onFinish={onFinished} />;
        break;
      default:
        content = <ChoicesStep me={me} setMe={setMe} resumed={resumed} onSaved={() => setStep("devices")} />;
    }
  const shown = claimed ? "claimed" : !me && step !== "account" ? "welcome" : step;
  return (
    <Walkthrough step={shown} steps={PROGRESS} label="Setup steps">
      {content}
    </Walkthrough>
  );
}

function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <>
      <RelayScene />
      <StepTitle>Welcome to Relay</StepTitle>
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

/** Thrown before asking the server when the setup key field is empty. */
class KeyMissing extends Error {}

function AccountStep({
  keyRequired,
  onBack,
  onCreated,
  onClaimed,
}: {
  keyRequired: boolean;
  onBack: () => void;
  onCreated: (me: Me) => void;
  onClaimed: () => void;
}) {
  const [setupKey, setSetupKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const keyField = useRef<HTMLInputElement>(null);
  const keyHintId = useId();
  // The key comes first, so it takes focus from the username the form focuses on its own.
  useEffect(() => {
    if (keyRequired) keyField.current?.focus();
  }, [keyRequired]);
  const refuseKey = (message: string) => {
    setKeyError(message);
    keyField.current?.focus();
    return true;
  };
  return (
    <>
      <button type="button" className="setup-back link" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden /> Back
      </button>
      <StepTitle>Create your account</StepTitle>
      <p className="setup-lead">
        You’ll be Relay’s administrator: the one who invites people and looks after it. You can add a name, a passkey
        and your other devices later.
      </p>
      <div className="setup-card card-surface">
        <AccountForm
          id="setup"
          submitLabel="Create account"
          before={
            keyRequired && (
              <Field
                label="Setup key"
                after={
                  <span
                    id={keyHintId}
                    className={keyError ? "field-error" : "field-hint"}
                    role={keyError ? "alert" : undefined}
                  >
                    {keyError || "This server asks for its one-time key, from setup.key in its data folder."}
                  </span>
                }
              >
                <input
                  ref={keyField}
                  aria-describedby={keyHintId}
                  className="input"
                  type="password"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={128}
                  aria-invalid={!!keyError || undefined}
                  value={setupKey}
                  onChange={(event) => {
                    setSetupKey(event.target.value.trim());
                    setKeyError("");
                  }}
                />
              </Field>
            )
          }
          create={async (account) => {
            if (keyRequired && !setupKey) throw new KeyMissing();
            onCreated(
              await call(api.setup.account, {
                body: { ...account, ...thisDevice(), setupKey: setupKey || undefined },
              }),
            );
          }}
          onError={(e) => {
            // No account exists while this step shows, so a conflict means someone else got there first.
            if (e instanceof ApiError && e.status === 409) {
              onClaimed();
              return true;
            }
            if (e instanceof KeyMissing) return refuseKey("Enter the setup key.");
            if (e instanceof ApiError && e.status === 403) return refuseKey(e.message);
            return false;
          }}
        />
      </div>
    </>
  );
}

const GB = 1024 ** 3;

/** Most of the disk's free space, rounded down to a figure that reads at a glance. */
function suggestedCapacity(free: number) {
  const usable = free * 0.9;
  if (usable < GB) return Math.max(1, Math.floor(usable / 1024 ** 2)) * 1024 ** 2;
  const gb = Math.floor(usable / GB);
  const step = gb >= 1000 ? 100 : gb >= 100 ? 10 : 1;
  return Math.floor(gb / step) * step * GB;
}

type Disk = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; free: number };

/** The administrator's own choices, and how much Relay may store for everyone together. */
function ChoicesStep({ me, setMe, resumed, onSaved }: { me: Me; setMe: SetMe; resumed: boolean; onSaved: () => void }) {
  const [disk, setDisk] = useState<Disk>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<ByteDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState("");
  const field = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setDisk({ state: "loading" });
    call(api.admin.overview)
      .then((o) => {
        if (!live) return;
        setDisk({ state: "ready", free: o.storage.diskFree });
        setDraft((current) => current ?? toDraft(suggestedCapacity(o.storage.diskFree)));
      })
      .catch((e: Error) => live && setDisk({ state: "failed", message: e.message }));
    return () => {
      live = false;
    };
  }, [attempt]);
  const capacity = draft ? fromDraft(draft) : null;
  const edit = () => {
    setEditing(true);
    setTimeout(() => field.current?.querySelector("input")?.focus());
  };

  let storage: ReactNode;
  if (disk.state !== "ready" || !draft)
    storage = (
      <div className="setup-total" role={disk.state === "failed" ? "alert" : undefined}>
        <span className="setup-question-icon" aria-hidden>
          <HardDrive size={18} />
        </span>
        {disk.state === "failed" ? (
          <>
            <p className="setup-total-text">
              <strong>Free space couldn’t be checked</strong>
              <span className="muted">{disk.message}</span>
            </p>
            <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </>
        ) : (
          <Spinner label="Checking free space" />
        )}
      </div>
    );
  else
    storage = (
      <>
        <div className="setup-total">
          <span className="setup-question-icon" aria-hidden>
            <HardDrive size={18} />
          </span>
          {editing ? (
            <div ref={field} className="setup-reveal setup-total-edit">
              <ByteSizeField
                label="Relay can store up to"
                hint={problem || `Shared by everyone you invite. ${bytes(disk.free)} is free on this disk.`}
                draft={draft}
                onChange={(next) => {
                  setDraft(next);
                  setProblem("");
                }}
                invalid={capacity === null}
              />
            </div>
          ) : (
            <p className="setup-total-text">
              <strong>Relay can store up to {capacity === null ? "…" : bytes(capacity)}</strong>
              <span className="muted">
                Shared by everyone you invite. That’s most of the {bytes(disk.free)} free on this disk.
              </span>
            </p>
          )}
          {!editing && (
            <Button size="sm" variant="ghost" aria-label="Change how much Relay can store" onClick={edit}>
              Change
            </Button>
          )}
        </div>
        {capacity !== null && capacity > disk.free && (
          <p className="notice" role="status">
            That’s more than the {bytes(disk.free)} free on this disk. Uploads will stop when the disk is full.
          </p>
        )}
      </>
    );

  return (
    <YoursStep
      me={me}
      setMe={setMe}
      resumed={resumed}
      storage={storage}
      check={() => {
        if (disk.state !== "ready") return false;
        if (capacity !== null) return true;
        setProblem("Enter an amount more than zero.");
        edit();
        return false;
      }}
      finish={async () => {
        await call(api.setup.finish, { body: { capacity: capacity! } });
      }}
      onSaved={onSaved}
    />
  );
}

type Invitation = { token: string; code: string; expires: number };

function InviteStep({ onNext }: { onNext: () => void }) {
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
      <StepTitle>Bring your people in</StepTitle>
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
            detail={`Works once, until ${dateTime(invite.expires)}. The link can’t be shown again after you leave this page; the code stays listed in Admin, where you can also set limits until it’s used.`}
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

function Done({ onFinish }: { onFinish: () => void }) {
  return (
    <>
      <DoneScene />
      <StepTitle>You’re all set</StepTitle>
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

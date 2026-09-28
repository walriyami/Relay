// A new member's welcome: the invitation, their account, their own choices, their other devices,
// done. Once the account exists the address is /welcome, so a reload picks up where it left off.
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, FolderInput, FolderOpen, HardDrive, Link2, Send, Smartphone } from "lucide-react";
import { ApiError, api, call, type InvitationCheck, type Me } from "../../api";
import { displayName } from "../../../shared/model";
import type { SetMe } from "../../app/session";
import { bytes, dateTime } from "../../lib/format";
import { navigate } from "../../lib/router";
import { Button, Spinner } from "../../components/ui";
import { AccountForm } from "../auth/Auth";
import { thisDevice } from "../auth/device-name";
import { DevicesStep } from "../setup/DevicesStep";
import { DoneScene, RelayScene } from "../setup/scenes";
import { Point, StepTitle, Walkthrough } from "../setup/Walkthrough";
import { YoursStep } from "../setup/YoursStep";

type Step = "welcome" | "account" | "yours" | "devices" | "done";
/** The steps that ask something, shown as progress. Welcome and done frame them. */
const PROGRESS: { step: Step; label: string }[] = [
  { step: "account", label: "Your account" },
  { step: "yours", label: "Make it yours" },
  { step: "devices", label: "Your devices" },
];

type Invitation =
  | { state: "checking" }
  | { state: "open"; invite: InvitationCheck }
  | { state: "gone" }
  | { state: "error"; message: string };

const invitationError = (e: unknown) =>
  e instanceof ApiError && e.status === 429 ? "Too many attempts. Wait a minute and try again." : (e as Error).message;

export function Join({
  token,
  me,
  onJoined,
  setMe,
  onFinished,
}: {
  /** The invitation, while there is no account yet. */
  token: string;
  /** Signed in: the account exists, and the welcome continues from the member's choices. */
  me: Me | null;
  onJoined: (me: Me) => void;
  setMe: SetMe;
  onFinished: () => void;
}) {
  // Opened already signed in (a reload after joining): the account is made, the choices remain.
  const [resumed] = useState(!!me);
  const [step, setStep] = useState<Step>(me ? "yours" : "welcome");
  const [invitation, setInvitation] = useState<Invitation>({ state: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [devicesAdded, setDevicesAdded] = useState(0);
  useEffect(() => {
    if (resumed || !token) return;
    let live = true;
    setInvitation({ state: "checking" });
    call(api.session.invitation, { params: { token } })
      .then((invite) => live && setInvitation({ state: "open", invite }))
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && (e.status === 410 || e.status === 404)) setInvitation({ state: "gone" });
        else setInvitation({ state: "error", message: invitationError(e) });
      });
    return () => {
      live = false;
    };
  }, [resumed, token, attempt]);

  const signIn = () => navigate("/", true);
  let shown: string = step;
  let content: ReactNode;
  if (me)
    switch (step) {
      case "devices":
        content = (
          <DevicesStep
            onAdded={() => setDevicesAdded((n) => n + 1)}
            added={devicesAdded}
            onNext={() => setStep("done")}
          />
        );
        break;
      case "done":
        content = <Done me={me} addedDevice={devicesAdded > 0} onFinish={onFinished} />;
        break;
      default:
        shown = "yours";
        content = (
          <YoursStep
            me={me}
            setMe={setMe}
            resumed={resumed}
            storage={<MemberStorage me={me} />}
            onSaved={() => setStep("devices")}
          />
        );
    }
  else if (invitation.state !== "open") {
    shown = invitation.state;
    content =
      invitation.state === "checking" ? (
        <Spinner label="Checking your invitation" />
      ) : invitation.state === "gone" ? (
        <>
          <StepTitle>This invitation can’t be used</StepTitle>
          <p className="setup-lead">
            It expired, was already used or was withdrawn. Ask the person who invited you for a new link.
          </p>
          <div className="setup-actions">
            <p className="setup-aside">Already have an account?</p>
            <Button onClick={signIn}>Sign in</Button>
          </div>
        </>
      ) : (
        <>
          <StepTitle>Your invitation couldn’t be checked</StepTitle>
          <p className="setup-lead" role="alert">
            {invitation.message}
          </p>
          <div className="setup-actions">
            <Button variant="primary" className="setup-cta" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
            <Button variant="ghost" onClick={signIn}>
              Sign in instead
            </Button>
          </div>
        </>
      );
  } else if (step === "account")
    content = (
      <AccountStep
        token={token}
        onBack={() => setStep("welcome")}
        onJoined={(joined) => {
          onJoined(joined);
          setStep("yours");
        }}
        onGone={() => {
          setInvitation({ state: "gone" });
          setStep("welcome");
        }}
      />
    );
  else {
    shown = "welcome";
    content = <Welcome invite={invitation.invite} onStart={() => setStep("account")} onSignIn={signIn} />;
  }
  return (
    <Walkthrough step={shown} steps={PROGRESS} label="Joining steps">
      {content}
    </Walkthrough>
  );
}

function Welcome({
  invite,
  onStart,
  onSignIn,
}: {
  invite: InvitationCheck;
  onStart: () => void;
  onSignIn: () => void;
}) {
  return (
    <>
      <RelayScene />
      <StepTitle>You’re invited to Relay</StepTitle>
      <p className="setup-lead">
        {invite.invitedBy} invited you to join. Relay is a private place to move files between your devices and share
        them with anyone.
      </p>
      <ul className="setup-points">
        <Point icon={<Smartphone size={18} />} title="Send to any of your devices">
          Files go straight to your phone, laptop or tablet.
        </Point>
        <Point icon={<Link2 size={18} />} title="Share with a link or a code">
          Anyone can download what you share. No account needed.
        </Point>
        <Point icon={<FolderInput size={18} />} title="Ask for files">
          Send someone a request link, and they can upload straight to you.
        </Point>
      </ul>
      <div className="setup-actions">
        <Button variant="primary" className="setup-cta" onClick={onStart}>
          Accept invitation
          <ArrowRight size={16} aria-hidden />
        </Button>
        <p className="setup-aside">This invitation works once, until {dateTime(invite.expires)}.</p>
        <p className="setup-aside">
          Already have an account?{" "}
          <button type="button" className="link" onClick={onSignIn}>
            Sign in
          </button>
        </p>
      </div>
    </>
  );
}

function AccountStep({
  token,
  onBack,
  onJoined,
  onGone,
}: {
  token: string;
  onBack: () => void;
  onJoined: (me: Me) => void;
  onGone: () => void;
}) {
  return (
    <>
      <button type="button" className="setup-back link" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden /> Back
      </button>
      <StepTitle>Create your account</StepTitle>
      <p className="setup-lead">This is how you’ll sign in to Relay, on this device and on any other.</p>
      <div className="setup-card card-surface">
        <AccountForm
          id="join"
          submitLabel="Create account"
          create={async (account) =>
            onJoined(await call(api.session.join, { body: { token, ...account, ...thisDevice() } }))
          }
          onError={(e) => {
            if (!(e instanceof ApiError && e.status === 410)) return false;
            onGone();
            return true;
          }}
        />
      </div>
    </>
  );
}

/** How much space the new member has: their own limit, or what the server has free for everyone. */
function MemberStorage({ me }: { me: Me }) {
  const limit = me.user.limits.storage;
  return (
    <div className="setup-total">
      <span className="setup-question-icon" aria-hidden>
        <HardDrive size={18} />
      </span>
      <p className="setup-total-text">
        <strong>
          {limit === null ? `${bytes(me.usage.available)} of space to use` : `You have ${bytes(limit)} of space`}
        </strong>
        <span className="muted">
          {me.user.admin
            ? "Shared with everyone on this Relay. You can change it in Admin."
            : limit === null
              ? "Shared with everyone on this Relay. See what you use any time in Settings."
              : "Your administrator can give you more if you need it."}
        </span>
      </p>
    </div>
  );
}

function Done({ me, addedDevice, onFinish }: { me: Me; addedDevice: boolean; onFinish: () => void }) {
  return (
    <>
      <DoneScene />
      <StepTitle>You’re all set</StepTitle>
      <p className="setup-lead">Welcome to Relay, {displayName(me.user)}. Here are a few good first steps.</p>
      <ul className="setup-points">
        <Point icon={<Send size={18} />} title="Send your first file">
          Drop anything on the Send page, then choose a device or a link.
        </Point>
        {addedDevice ? (
          <Point icon={<FolderInput size={18} />} title="Ask for files">
            Create a request, and anyone with its link can upload to you.
          </Point>
        ) : (
          <Point icon={<Smartphone size={18} />} title="Add your phone">
            Choose Add a device on the Send page, then scan the code with your phone.
          </Point>
        )}
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

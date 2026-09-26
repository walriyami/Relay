import { useEffect, useRef, useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { api, call, type Passkey } from "../../api";
import { ago, date } from "../../lib/format";
import { useLive } from "../../lib/live";
import { addPasskey, passkeyDismissed, passkeysSupported } from "../auth/passkeys";
import { browserName } from "../auth/device-name";
import { Button, InlineEmpty, Menu, confirmDialog, Field, Modal, toast } from "../../components/ui";
import { Section } from "./Section";

export function PasskeysSection() {
  // Browsers without WebAuthn can't create or use passkeys, so there's nothing to offer here.
  if (!passkeysSupported()) return null;
  return <Passkeys />;
}

function Passkeys() {
  const { data, loading, error, reload } = useLive(api.account.passkeys, {}, ["account"], []);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(browserName());
  const [password, setPassword] = useState("");
  const [addError, setAddError] = useState("");
  const passwordInput = useRef<HTMLInputElement>(null);
  // After a refusal the (cleared) password field takes focus again, described by the error.
  useEffect(() => {
    if (addError && !busy) passwordInput.current?.focus();
  }, [addError, busy]);
  function closeAdd() {
    setAdding(false);
    setPassword("");
    setAddError("");
  }
  async function add() {
    setBusy(true);
    setAddError("");
    try {
      await addPasskey(password, name.trim());
      closeAdd();
      reload();
      toast("Passkey added. You can sign in with it now.", { tone: "success" });
    } catch (e) {
      if (!passkeyDismissed(e)) setAddError((e as Error).message);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }
  async function remove(p: Passkey) {
    const ok = await confirmDialog({
      title: `Remove “${p.name}”?`,
      body: "You won’t be able to sign in with this passkey anymore. Delete it from your password manager too.",
      confirm: "Remove",
      danger: true,
    });
    if (!ok) return;
    try {
      await call(api.account.removePasskey, { params: { id: p.id } });
      reload();
      toast("Passkey removed");
    } catch (e) {
      toast((e as Error).message, { tone: "error" });
    }
  }
  return (
    <Section
      id="s-passkeys"
      title="Passkeys"
      description="Sign in with your fingerprint, face or device PIN instead of a password."
    >
      {error && <p className="notice">{error}</p>}
      {data.length > 0 ? (
        <ul className="device-list" aria-label="Passkeys">
          {data.map((p) => (
            <li key={p.id} className="device-row">
              <span className="device-icon">
                <KeyRound size={18} aria-hidden />
              </span>
              <span className="device-text">
                <strong>{p.name}</strong>
                <span className="muted">
                  Added {date(p.created)} · {p.lastUsed ? `Last used ${ago(p.lastUsed)}` : "Not used yet"}
                </span>
              </span>
              <Menu
                label={`Actions for ${p.name}`}
                items={[{ label: "Remove", danger: true, onSelect: () => void remove(p) }]}
              />
            </li>
          ))}
        </ul>
      ) : (
        !loading &&
        !error && (
          <InlineEmpty icon={<KeyRound size={20} />} title="No passkeys added">
            Add one to sign in with your device instead of a password.
          </InlineEmpty>
        )
      )}
      <div className="row">
        <Button
          icon={<Plus size={16} />}
          busy={busy}
          onClick={() => {
            setName(browserName());
            setAdding(true);
          }}
        >
          Add a passkey
        </Button>
      </div>
      {adding && (
        <Modal title="Add a passkey" size="sm" onClose={closeAdd}>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void add();
            }}
          >
            <Field label="Name" hint="Helps you tell your passkeys apart.">
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={160}
                disabled={busy}
              />
            </Field>
            <Field
              label="Current password"
              hint="Confirm your password before your browser asks for your fingerprint, face or device PIN."
            >
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                ref={passwordInput}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                data-autofocus
                disabled={busy}
                aria-invalid={!!addError}
                aria-describedby={addError ? "add-passkey-error" : undefined}
              />
            </Field>
            {addError && (
              <p id="add-passkey-error" className="notice" role="alert">
                {addError}
              </p>
            )}
            <div className="row">
              <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !password}>
                Continue
              </Button>
              <Button onClick={closeAdd} disabled={busy}>
                Cancel
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </Section>
  );
}

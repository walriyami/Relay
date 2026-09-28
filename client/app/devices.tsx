// One device identity and editor, wherever the device appears.
import { createContext, useContext, useId, useRef, useState, type ReactNode } from "react";
import { Check, Laptop, Pencil, Smartphone, Tablet } from "lucide-react";
import { api, ApiError, call, LIMITS, type Device, type DeviceKind } from "../api";
import { Button, Field, Modal, toast } from "../components/ui";
import { useSession } from "./session";

const ICONS = { phone: Smartphone, tablet: Tablet, computer: Laptop };
const KINDS: { value: DeviceKind; label: string }[] = [
  { value: "computer", label: "Computer" },
  { value: "phone", label: "Phone" },
  { value: "tablet", label: "Tablet" },
];

/** The saved icon, initially detected at sign-in and independent of the device's name. */
export function DeviceIcon({ device, size = 18 }: { device: Pick<Device, "kind">; size?: number }) {
  const Icon = ICONS[device.kind] ?? Laptop;
  return <Icon size={size} aria-hidden />;
}

type EditableDevice = Pick<Device, "id" | "name" | "kind" | "current">;
const EditorContext = createContext<((device: EditableDevice) => void) | null>(null);

export function DeviceEditorProvider({ children }: { children: ReactNode }) {
  const [device, edit] = useState<EditableDevice | null>(null);
  return (
    <EditorContext.Provider value={edit}>
      {children}
      {device && <DeviceEditor key={device.id} device={device} onClose={() => edit(null)} />}
    </EditorContext.Provider>
  );
}

export function useEditDevice() {
  const edit = useContext(EditorContext);
  if (!edit) throw new Error("Device editor unavailable");
  return edit;
}

/**
 * This device isn't somewhere to send, but the others list it by this name and icon, so that is
 * what it says, and the name is where to change them. Right after signing up it's the first thing
 * worth renaming, with nothing else in the list yet.
 */
export function ThisDeviceName() {
  const { me, devices } = useSession();
  const edit = useEditDevice();
  // The device list hears about changes made on other devices, so it's the fresher of the two.
  const device = devices.find((d) => d.current) ?? { ...me.device, current: true };
  return (
    <p className="this-device">
      <span>Your devices see this one as</span>
      <button
        type="button"
        className="this-device-name"
        aria-label={`Edit this device, ${device.name}`}
        title="Edit this device"
        onClick={(event) => {
          // Safari doesn't focus a clicked button; the editor returns focus to what had it.
          event.currentTarget.focus();
          edit(device);
        }}
      >
        <DeviceIcon device={device} size={14} />
        <span className="this-device-label">{device.name}</span>
        <Pencil className="this-device-edit" size={12} aria-hidden />
      </button>
    </p>
  );
}

function DeviceEditor({ device, onClose }: { device: EditableDevice; onClose: () => void }) {
  const { setMe, reloadDevices } = useSession();
  const [name, setName] = useState(device.name);
  const [kind, setKind] = useState(device.kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; name: boolean } | null>(null);
  const saving = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const cleanName = name.trim();
  const changed = cleanName !== device.name || kind !== device.kind;
  const close = () => {
    if (!saving.current) onClose();
  };
  async function save() {
    if (saving.current || !cleanName || !changed) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await call(api.devices.update, { params: { id: device.id }, body: { name: cleanName, kind } });
      if (device.current) setMe((me) => ({ ...me, device: { ...me.device, name: cleanName, kind } }));
      reloadDevices();
      toast(device.current ? "This device updated" : "Device updated");
      onClose();
    } catch (e) {
      const nameError = e instanceof ApiError && e.status === 409;
      setError({ message: (e as Error).message || "That didn’t work. Try again.", name: nameError });
      if (nameError) field.current?.focus();
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title={device.current ? "Edit this device" : "Edit device"}
      subtitle={`Choose how ${device.current ? "this device" : "it"} appears across Relay.`}
      size="sm"
      dismissible={!busy}
      onClose={close}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={id} busy={busy} disabled={!cleanName || !changed}>
            Save
          </Button>
        </>
      }
    >
      <form
        id={id}
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="Device name">
          <input
            ref={field}
            className="input"
            data-autofocus
            value={name}
            required
            maxLength={LIMITS.nameLength}
            readOnly={busy}
            autoComplete="off"
            aria-invalid={error?.name || undefined}
            aria-describedby={error?.name ? `${id}-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            onFocus={(event) => event.target.select()}
          />
        </Field>
        <fieldset className="device-icon-picker" disabled={busy}>
          <legend>Icon</legend>
          <div className="device-icon-options">
            {KINDS.map(({ value, label }) => (
              <label className="device-icon-option" key={value}>
                <input
                  type="radio"
                  name={`${id}-icon`}
                  value={value}
                  checked={kind === value}
                  onChange={() => setKind(value)}
                />
                <span className="device-icon-choice">
                  <DeviceIcon device={{ kind: value }} size={26} />
                  <span>{label}</span>
                  {kind === value && <Check className="device-icon-check" size={13} aria-hidden />}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p className="field-error" id={`${id}-error`} role="alert">
            {error.message}
          </p>
        )}
      </form>
    </Modal>
  );
}

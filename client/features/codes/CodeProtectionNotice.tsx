import type { CodeLength, PickupProtection } from "../../../shared/codes";
import { dateTime } from "../../lib/format";
import { useCodeConfig } from "./config";

export function CodeProtectionNotice({
  protection,
  effectiveCodeLength,
  owner = false,
}: {
  protection: (Omit<PickupProtection, "addressPausedUntil"> & { addressPausedUntil?: number | null }) | null;
  effectiveCodeLength?: CodeLength | null;
  owner?: boolean;
}) {
  if (!protection) return null;
  const now = Date.now();
  const unavailable = protection.numericCodeResolutionUnavailable;
  const paused = protection.pausedUntil && protection.pausedUntil > now;
  const addressPaused = protection.addressPausedUntil && protection.addressPausedUntil > now;
  const heightened = protection.heightenedUntil && protection.heightenedUntil > now;
  const capacityFallback = !heightened && protection.preferredCodeLength === 4 && effectiveCodeLength === 6;
  const recent = protection.lastAttackAt && now - protection.lastAttackAt < 24 * 60 * 60_000;
  if (!unavailable && !paused && !addressPaused && !heightened && !capacityFallback && !(owner && recent)) return null;
  return (
    <div className="notice" role="status" aria-live="polite">
      <p>
        {unavailable
          ? "Code entry is unavailable because Relay could not allocate fresh codes. Use a link or QR code."
          : paused
            ? `Code entry is paused for everyone after repeated incorrect guesses. Next retry: ${dateTime(protection.pausedUntil!)}.`
            : addressPaused
              ? `Code entry from this network is paused after repeated incorrect guesses. Next retry: ${dateTime(protection.addressPausedUntil!)}.`
              : heightened
                ? "Extra code protection is active after repeated incorrect guesses."
                : capacityFallback
                  ? "Six-digit codes are active because no fresh four-digit codes are available."
                  : "Relay recently activated code protection after repeated incorrect guesses."}
      </p>
      {!unavailable && heightened && protection.preferredCodeLength === 4 && (
        <p>
          Codes have temporarily changed to six digits. Ask the sender for the current code. Four-digit codes return
          after a quiet recovery period if fresh codes are available; old codes remain invalid. Continued guessing
          extends protection.
        </p>
      )}
      {capacityFallback && <p>Retired codes are never reused. Ask the sender for the current six-digit code.</p>}
      <p>Links and QR codes keep working. Use the original link or ask the sender for it.</p>
      {owner && (
        <p>
          Review your shared links and revoke any you no longer need. Administrators can change the preferred code
          length in Admin → Codes. A pause limits guessing; it does not prove that no code was guessed earlier.
        </p>
      )}
      {owner && protection.lastAttackAt && <p>Last protection event: {dateTime(protection.lastAttackAt)}.</p>}
    </div>
  );
}

/** Keeps signed-in users aware even when they do not have a code dialog open. */
export function CodeProtectionBanner() {
  const { protection, codeLength } = useCodeConfig();
  return <CodeProtectionNotice protection={protection} effectiveCodeLength={codeLength} owner />;
}

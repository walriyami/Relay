import { deviceKind, deviceLabel } from "../../../shared/devices";

/** A readable default name for this browser, e.g. "Safari on iPhone". */
export const browserName = () => deviceLabel(navigator.userAgent, navigator.maxTouchPoints);

/** How this browser introduces itself when signing in: its default name and icon. */
export const thisDevice = () => ({
  deviceName: browserName(),
  deviceKind: deviceKind(navigator.userAgent, navigator.maxTouchPoints),
});

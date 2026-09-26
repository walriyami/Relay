import { deviceLabel } from "../../../shared/devices";

/** A readable default name for this browser, e.g. "Safari on iPhone". */
export const browserName = () => deviceLabel(navigator.userAgent);

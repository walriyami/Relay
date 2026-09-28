import type { DeviceKind } from "./model.ts";

/**
 * iPadOS browsers present themselves as a Mac by default; only a touch screen gives them away, and
 * only the browser itself knows that (`navigator.maxTouchPoints`). Macs report no touch points.
 */
const isIPad = (ua: string, touchPoints: number) => /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);

/** A phone, tablet or computer, from a user agent. Android tablets leave "Mobile" out of theirs. */
export function deviceKind(ua: string, touchPoints = 0): DeviceKind {
  if (isIPad(ua, touchPoints) || /Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) return "tablet";
  if (/iPhone|iPod|Android|Mobile/.test(ua)) return "phone";
  return "computer";
}

/** A readable label for a browser from its user agent, e.g. "Safari on iPhone". */
export function deviceLabel(ua: string, touchPoints = 0) {
  const platform = isIPad(ua, touchPoints)
    ? "iPad"
    : /iPhone/.test(ua)
      ? "iPhone"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac/.test(ua)
            ? "Mac"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux|X11/.test(ua)
                ? "Linux"
                : "";
  const browser = /Edg(?:e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /Firefox|FxiOS/.test(ua)
      ? "Firefox"
      : /Chrome|CriOS/.test(ua)
        ? "Chrome"
        : /Safari/.test(ua)
          ? "Safari"
          : "";
  if (!browser && !platform) return "Unknown browser";
  return `${browser || "Browser"} on ${platform || "an unknown device"}`;
}

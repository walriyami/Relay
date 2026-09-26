/** A readable label for a browser from its user agent, e.g. "Safari on iPhone". */
export function deviceLabel(ua: string) {
  const platform = /iPad/.test(ua)
    ? "iPad"
    : /iPhone/.test(ua)
      ? "iPhone"
      : /Android/.test(ua)
        ? "Android"
        : /Mac/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux|X11|CrOS/.test(ua)
              ? "Linux"
              : "";
  const browser = /Edg\//.test(ua)
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

// Runs before first paint so a dark theme never flashes light. client/lib/local-prefs.ts owns the
// same "relay-local-prefs" key and keeps the theme current afterwards.
(function () {
  var theme = "system";
  try {
    theme = JSON.parse(localStorage.getItem("relay-local-prefs") || "{}").theme || "system";
  } catch (e) {}
  var dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]').setAttribute("content", dark ? "#0b0c0e" : "#f6f6f4");
})();

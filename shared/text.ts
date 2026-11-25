// Text people type for other people to read: names, notes and messages. Hidden characters could
// otherwise make a name span several lines, posing as a notice from Relay, or show its letters in
// a different order from the one stored ("…exe.txt" read as "…txt.exe").

/** Characters that change the direction text is shown in. They're invisible, so they're dropped. */
const DIRECTION = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Control characters, including line breaks, and Unicode's line and paragraph separators. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what's replaced.
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
/** Control characters other than the line feed, which a message keeps. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what's removed.
const CONTROL_BUT_NEWLINE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;

/** A name or short label: one line, with control characters as spaces and runs of space as one. */
export function oneLine(value: string): string {
  return value.normalize("NFC").replace(DIRECTION, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/** A message that may span lines: line breaks become "\n", tabs spaces, other control characters go. */
export function plainText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?|[\x85\u2028\u2029]/g, "\n")
    .replace(/\t/g, " ")
    .replace(DIRECTION, "")
    .replace(CONTROL_BUT_NEWLINE, "")
    .trim();
}

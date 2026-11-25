// Text people type for other people to read: names, notes and messages. Hidden characters could
// otherwise make a name span several lines, posing as a notice from Relay, or show its letters in
// a different order from the one stored ("…exe.txt" read as "…txt.exe").

/** Invisible characters that change the direction text is shown in, so they're dropped. */
const DIRECTION = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/**
 * Of those, the ones that can reorder a whole run of text: embeddings, overrides and isolates. A
 * message keeps the single-character marks (LRM, RLM, ALM) that right-to-left writing relies on.
 */
const DIRECTION_RUNS = /[\u202a-\u202e\u2066-\u2069]/g;
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
    .replace(DIRECTION_RUNS, "")
    .replace(CONTROL_BUT_NEWLINE, "")
    .trim();
}

/**
 * Text as shown, without the embeddings, overrides and isolates that could reorder it and the words
 * after it: names and notes stored before these rules may hold them. Where it can, the web app also
 * sets the text apart from Relay's own words (<bdi>), so right-to-left letters can't move them either.
 */
export function shownText(value: string): string {
  return value.replace(DIRECTION_RUNS, "");
}

// File and folder names. Beyond what a file system refuses, a name must show what it is: nothing in
// it may be invisible, or blank space in disguise, or push its real ending out of sight
// ("invoice.pdf" followed by 50 spaces and ".exe" shows as "invoice.pdf …").

/**
 * Characters that show as blank space or as nothing, yet aren't ordinary spaces or the joiners real
 * writing needs: Hangul fillers, the blank braille pattern, the zero-width space, word joiners and
 * other invisible operators, the byte-order mark, Khmer invisible vowels, and interlinear annotation
 * marks. What real writing needs stays: zero-width joiners and non-joiners (emoji, Indic scripts,
 * Persian), variation selectors, and the Mongolian vowel separator. Other characters that show as
 * nothing (a soft hyphen, emoji tags) can't make a gap, so they stay too.
 */
const HIDDEN = /[\u115f\u200b\u2060-\u206f\u2800\u3164\ufeff\uffa0\ufff9-\ufffb]|\u1160|\u17b4|\u17b5/g;
/** The most spaces a name may have in a row. Characters that show nothing don't break a run. */
export const MAX_SPACES = 3;
const SPACE_RUN = new RegExp(`(?:\\s\\p{Default_Ignorable_Code_Point}*){${MAX_SPACES + 1},}`, "gu");
/** Spaces, and characters that show nothing at all. */
const BLANK = /[\s\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Whether a file or folder name hides something: a direction mark, a hidden character, more than
 * MAX_SPACES spaces in a row, or nothing visible at all.
 */
export function fileNameHides(name: string): boolean {
  // `search` always starts at the beginning, whatever a global pattern matched before.
  return (
    name.search(DIRECTION) >= 0 ||
    name.search(HIDDEN) >= 0 ||
    name.search(SPACE_RUN) >= 0 ||
    name.replace(BLANK, "") === ""
  );
}

/**
 * A name from elsewhere (a file on disk, a Nearby peer, words typed as a name) made into one that
 * hides nothing: direction marks and hidden characters go; control characters and long runs of
 * spaces become one space. "" when nothing visible is left, for the caller to choose a name.
 */
export function cleanFileName(value: string): string {
  const name = value
    .normalize("NFC")
    .replace(DIRECTION, "")
    .replace(CONTROL, " ")
    .replace(HIDDEN, "")
    .replace(SPACE_RUN, " ")
    .trim();
  return name.replace(BLANK, "") === "" ? "" : name;
}

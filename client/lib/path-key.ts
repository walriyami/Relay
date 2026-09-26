/** Normalize path identity the way SQLite NOCASE plus server cleanName do. */
export const pathKey = (value: string) => value.normalize("NFC").replace(/[A-Z]/g, (c) => c.toLowerCase());

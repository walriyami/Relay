// Bringing an existing database up to server/db/schema.sql, which is edited in place.
//
// The schema file is the only description of the database; there are no migration files. At
// startup the live database is compared with a fresh copy of schema.sql, ignoring comments,
// formatting and column order. Changes that keep every row are applied in one transaction: new
// tables, new columns (nullable or with a default), and new, changed or removed indexes, triggers
// and views. Anything that could lose or reinterpret data (a removed table or column, a changed
// column or table constraint) is refused before anything is touched, with a message naming it.
import { DatabaseSync } from "node:sqlite";

export type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };

const OBJECTS =
  "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name";

export function schemaObjects(sqlite: DatabaseSync): SchemaObject[] {
  return sqlite.prepare(OBJECTS).all() as SchemaObject[];
}

/** The objects schema.sql creates in an empty database. */
export function expectedObjects(schema: string): SchemaObject[] {
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec(schema);
    return schemaObjects(reference);
  } finally {
    reference.close();
  }
}

/**
 * SQL with comments removed, whitespace collapsed and words in lower case; quoted text is kept
 * exactly. Only spaces between words are kept, so `A ( b,c )` and `a(b, c)` read the same.
 */
export function normalizeSql(sql: string): string {
  let out = "";
  let space = false;
  // Only whitespace between two words (or quoted names and text) can matter.
  let wordBefore = false;
  const emit = (text: string) => {
    const word = /^[\w$'"`[]/.test(text);
    if (space && wordBefore && word) out += " ";
    space = false;
    wordBefore = word;
    out += text;
  };
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      space = true;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      space = true;
    } else if (/\s/.test(c)) {
      i++;
      space = true;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === close) {
          // A doubled quote is a quote inside the text.
          if (close !== "]" && sql[j + 1] === close) j += 2;
          else break;
        } else j++;
      }
      emit(sql.slice(i, j + 1));
      i = j + 1;
    } else {
      let j = i + 1;
      if (/[\w$]/.test(c)) while (j < sql.length && /[\w$]/.test(sql[j])) j++;
      // Keywords and bare names are case-insensitive in SQLite.
      emit(sql.slice(i, j).toLowerCase());
      i = j;
    }
  }
  return out.replace(/;$/, "");
}

/** Splits at commas outside parentheses and quotes. Expects normalized SQL. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "[") quote = "]";
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(body.slice(start).trim());
  return parts.filter(Boolean);
}

const unquote = (name: string) => name.replace(/^["`[]|["`\]]$/g, "").toLowerCase();

export type TableShape = {
  /** Column name (lower case) to its normalized definition. */
  columns: Map<string, string>;
  /** Table constraints, sorted. */
  constraints: string[];
  /** STRICT, WITHOUT ROWID: upper case, sorted. */
  options: string[];
};

/** The parts of a CREATE TABLE statement that decide what rows it holds. */
export function tableShape(sql: string): TableShape {
  const text = normalizeSql(sql);
  const open = text.indexOf("(");
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (open < 0 || close < 0) throw new Error(`Unreadable table definition: ${sql.slice(0, 80)}`);
  const columns = new Map<string, string>();
  const constraints: string[] = [];
  for (const part of splitTopLevel(text.slice(open + 1, close))) {
    if (/^(constraint|primary|unique|check|foreign)\b/i.test(part)) constraints.push(part);
    else {
      const name = /^("[^"]*"|`[^`]*`|\[[^\]]*\]|[\w$]+)/.exec(part)![0];
      columns.set(unquote(name), part.slice(name.length).trim());
    }
  }
  const options = text
    .slice(close + 1)
    .split(",")
    .map((o) => o.trim().toUpperCase().replace(/\s+/g, " "))
    .filter(Boolean)
    .sort();
  return { columns, constraints: constraints.sort(), options };
}

export class SchemaRefused extends Error {
  readonly code = "RELAY_SCHEMA_INCOMPATIBLE";
}

export type SchemaPlan = {
  /** Statements to run, in order, in one transaction. */
  statements: string[];
  /** Plain descriptions of what they change, for the log. */
  changes: string[];
};

/**
 * What it takes to bring `live` to `expected`. Throws SchemaRefused, naming every table involved,
 * when a difference would lose or reinterpret data.
 */
export function planUpgrade(live: SchemaObject[], expected: SchemaObject[]): SchemaPlan {
  const key = (o: SchemaObject) => `${o.type}:${o.name.toLowerCase()}`;
  const have = new Map(live.map((o) => [key(o), o]));
  const want = new Map(expected.map((o) => [key(o), o]));
  const refusals: string[] = [];
  const statements: string[] = [];
  const changes: string[] = [];
  const drops: string[] = [];
  const creates: string[] = [];

  for (const [k, current] of have) {
    if (want.has(k)) continue;
    if (current.type === "table")
      refusals.push(`the table "${current.name}" is in the database but no longer in schema.sql`);
    else {
      drops.push(`DROP ${current.type.toUpperCase()} "${current.name}"`);
      changes.push(`removed ${current.type} ${current.name}`);
    }
  }
  for (const [k, target] of want) {
    const current = have.get(k);
    if (!current) {
      (target.type === "table" ? statements : creates).push(target.sql);
      changes.push(`added ${target.type} ${target.name}`);
      continue;
    }
    if (normalizeSql(current.sql) === normalizeSql(target.sql)) continue;
    if (target.type !== "table") {
      // Indexes, triggers and views hold no rows of their own: rebuild them from schema.sql.
      drops.push(`DROP ${target.type.toUpperCase()} "${target.name}"`);
      creates.push(target.sql);
      changes.push(`updated ${target.type} ${target.name}`);
      continue;
    }
    const from = tableShape(current.sql);
    const to = tableShape(target.sql);
    const problems: string[] = [];
    for (const [column, definition] of from.columns) {
      const wanted = to.columns.get(column);
      if (wanted === undefined) problems.push(`its column "${column}" was removed`);
      else if (wanted !== definition) problems.push(`its column "${column}" changed`);
    }
    if (from.constraints.join("\n") !== to.constraints.join("\n")) problems.push("its table constraints changed");
    if (from.options.join() !== to.options.join()) problems.push("its table options changed");
    if (problems.length) {
      refusals.push(`the table "${target.name}" changed in a way that could lose data (${problems.join(", ")})`);
      continue;
    }
    for (const [column, definition] of to.columns)
      if (!from.columns.has(column)) {
        statements.push(`ALTER TABLE "${target.name}" ADD COLUMN "${column}" ${definition}`);
        changes.push(`added column ${target.name}.${column}`);
      }
  }
  if (refusals.length)
    throw new SchemaRefused(
      `Relay can't open this database: ${refusals.join("; ")}. Relay has not changed your data. ` +
        "Undo that edit to server/db/schema.sql, or change it so it only adds tables, columns with a default, " +
        "or indexes. Removing or reshaping stored data needs a deliberate decision, not an automatic upgrade.",
    );
  // Old indexes and triggers go first, so a rebuilt one can reuse its name; tables precede what refers to them.
  return { statements: [...drops, ...statements, ...creates], changes };
}

/** True when two schemas hold the same tables and columns and the same indexes, triggers and views. */
export function sameSchema(a: SchemaObject[], b: SchemaObject[]) {
  try {
    return planUpgrade(a, b).statements.length === 0;
  } catch {
    return false;
  }
}

// One-off import of the old SQLite database (data/feedback.db) into Postgres.
//
// Statements with the same text become one question, assigned to every variant
// they were asked in. Their votes and ratings become that question's answers,
// with the original timestamps. The SQLite file is only read, never changed.
//
//   npm run import-sqlite            (or set DB_PATH to import another file)

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, initSchema, VARIANTS } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "feedback.db");

if (!existsSync(DB_PATH)) {
  console.error(`No SQLite database at ${DB_PATH}`);
  process.exit(1);
}

const sqlite = new DatabaseSync(DB_PATH, { readOnly: true });
const hasMode = sqlite.prepare("PRAGMA table_info(statements)").all().some((c) => c.name === "mode");
const statements = sqlite
  .prepare(`SELECT id, text, ${hasMode ? "mode" : "'thumbs'"} AS mode, created_at FROM statements ORDER BY id`)
  .all();
const answers = [
  ...sqlite.prepare("SELECT statement_id, answer, NULL AS rating, created_at FROM votes").all(),
  ...sqlite.prepare("SELECT statement_id, NULL AS answer, rating, created_at FROM ratings").all(),
];

// SQLite's datetime('now') is UTC without a zone.
const utc = (ts) => `${ts.replace(" ", "T")}Z`;

// Group statements by their text.
const byText = new Map();
for (const s of statements) {
  const text = s.text.trim();
  if (!byText.has(text)) byText.set(text, { text, created_at: s.created_at, modes: new Set(), ids: [] });
  const group = byText.get(text);
  group.modes.add(s.mode);
  group.ids.push(s.id);
}
const statementById = new Map(statements.map((s) => [s.id, s]));

await initSchema();
const client = await pool.connect();
try {
  const { rows: [{ n }] } = await client.query("SELECT count(*)::int AS n FROM questions");
  if (n > 0) {
    console.error(`Postgres already has ${n} questions. The import only runs into an empty database.`);
    process.exitCode = 1;
  } else {
    await client.query("BEGIN");

    const questionFor = new Map(); // SQLite statement id → Postgres question id
    for (const group of byText.values()) {
      const { rows: [{ id }] } = await client.query(
        "INSERT INTO questions (text, variants, created_at) VALUES ($1, $2, $3) RETURNING id",
        [group.text, VARIANTS.filter((v) => group.modes.has(v)), utc(group.created_at)]
      );
      for (const sid of group.ids) questionFor.set(sid, id);
    }

    for (const a of answers) {
      const statement = statementById.get(a.statement_id);
      if (!statement) continue;
      await client.query(
        "INSERT INTO answers (question_id, variant, answer, rating, created_at) VALUES ($1, $2, $3, $4, $5)",
        [questionFor.get(a.statement_id), a.rating == null ? "thumbs" : statement.mode, a.answer, a.rating, utc(a.created_at)]
      );
    }

    // The kiosk keeps running the variant of the most recent statement.
    const latest = statements.at(-1);
    if (latest) await client.query("UPDATE settings SET active_variant = $1", [latest.mode]);

    await client.query("COMMIT");
    console.log(
      `Imported ${statements.length} statements as ${byText.size} questions, with ${answers.length} answers.` +
        (latest ? ` Active variant: ${latest.mode}.` : "")
    );
  }
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  throw err;
} finally {
  client.release();
  await pool.end();
}

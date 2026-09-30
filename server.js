import express from "express";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD not set, using the default "admin". Set it before real use.');
}

// --- Database -------------------------------------------------------------

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "feedback.db");
mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS statements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS votes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_id INTEGER NOT NULL REFERENCES statements(id),
    answer       TEXT    NOT NULL CHECK (answer IN ('agree', 'disagree')),
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_votes_statement ON votes(statement_id);
  CREATE TABLE IF NOT EXISTS ratings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_id INTEGER NOT NULL REFERENCES statements(id),
    rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ratings_statement ON ratings(statement_id);
`);

// Migration: databases created before the stars variant have no `mode` column.
const MODES = ["thumbs", "stars"];
if (!db.prepare("PRAGMA table_info(statements)").all().some((c) => c.name === "mode")) {
  db.exec("ALTER TABLE statements ADD COLUMN mode TEXT NOT NULL DEFAULT 'thumbs'");
}

if (!db.prepare("SELECT 1 FROM statements LIMIT 1").get()) {
  db.prepare("INSERT INTO statements (text) VALUES (?)").run("Today's lesson was clear to me.");
}

const q = {
  current: db.prepare("SELECT id, text, mode, created_at FROM statements ORDER BY id DESC LIMIT 1"),
  byId: db.prepare("SELECT id, text, mode, created_at FROM statements WHERE id = ?"),
  all: db.prepare("SELECT id, text, mode, created_at FROM statements ORDER BY id DESC"),
  insertStatement: db.prepare("INSERT INTO statements (text, mode) VALUES (?, ?)"),
  insertVote: db.prepare("INSERT INTO votes (statement_id, answer) VALUES (?, ?)"),
  insertRating: db.prepare("INSERT INTO ratings (statement_id, rating) VALUES (?, ?)"),
  voteCounts: db.prepare(`
    SELECT
      COALESCE(SUM(answer = 'agree'), 0)    AS agree,
      COALESCE(SUM(answer = 'disagree'), 0) AS disagree
    FROM votes WHERE statement_id = ?`),
  ratingCounts: db.prepare(`
    SELECT rating, COUNT(*) AS n FROM ratings WHERE statement_id = ? GROUP BY rating`),
  export: db.prepare(`
    SELECT * FROM (
      SELECT 'vote' AS type, v.id AS id, v.statement_id AS statement_id, s.text AS statement,
             s.mode AS mode, v.answer AS answer, NULL AS rating, v.created_at AS created_at
      FROM votes v JOIN statements s ON s.id = v.statement_id
      UNION ALL
      SELECT 'rating', r.id, r.statement_id, s.text, s.mode, NULL, r.rating, r.created_at
      FROM ratings r JOIN statements s ON s.id = r.statement_id
    ) ORDER BY created_at, type, id`),
};

const percent = (n, total) => (total ? Math.round((n / total) * 100) : 0);

function results(statement) {
  const { id: statementId, mode } = statement;

  if (mode === "stars") {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const { rating, n } of q.ratingCounts.all(statementId)) counts[rating] = n;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const sum = Object.entries(counts).reduce((a, [star, n]) => a + star * n, 0);
    const pct = Object.fromEntries(Object.entries(counts).map(([star, n]) => [star, percent(n, total)]));
    const average = total ? Math.round((sum / total) * 10) / 10 : 0;
    return { statementId, mode, total, average, counts, pct };
  }

  const { agree, disagree } = q.voteCounts.get(statementId);
  const total = agree + disagree;
  return {
    statementId, mode, agree, disagree, total,
    agreePct: percent(agree, total),
    disagreePct: percent(disagree, total),
  };
}

// --- App ------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

function requireAdmin(req, res, next) {
  const given = Buffer.from(String(req.get("x-admin-password") ?? ""));
  const expected = Buffer.from(ADMIN_PASSWORD);
  if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
  res.status(401).json({ error: "Wrong admin password" });
}

app.get("/api/statement", (req, res) => {
  res.json(q.current.get());
});

app.post("/api/statement", requireAdmin, (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  const mode = req.body?.mode ?? "thumbs";
  if (!text || text.length > 300) {
    return res.status(400).json({ error: "Statement must be 1–300 characters" });
  }
  if (!MODES.includes(mode)) {
    return res.status(400).json({ error: 'mode must be "thumbs" or "stars"' });
  }
  const { lastInsertRowid } = q.insertStatement.run(text, mode);
  res.status(201).json(q.byId.get(lastInsertRowid));
});

// One endpoint for both variants: thumbs statements take {answer}, star statements take {rating}.
app.post("/api/votes", (req, res) => {
  const statementId = Number(req.body?.statementId);
  const statement = Number.isInteger(statementId) && q.byId.get(statementId);
  if (!statement) {
    return res.status(400).json({ error: "Unknown statementId" });
  }

  if (statement.mode === "stars") {
    const rating = req.body?.rating;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "rating must be a whole number from 1 to 5" });
    }
    q.insertRating.run(statementId, rating);
  } else {
    const answer = req.body?.answer;
    if (!["agree", "disagree"].includes(answer)) {
      return res.status(400).json({ error: 'answer must be "agree" or "disagree"' });
    }
    q.insertVote.run(statementId, answer);
  }
  res.status(201).json(results(statement));
});

app.get("/api/results", (req, res) => {
  const statement = req.query.statementId ? q.byId.get(Number(req.query.statementId)) : q.current.get();
  if (!statement) {
    return res.status(404).json({ error: "Unknown statementId" });
  }
  res.json(results(statement));
});

app.get("/api/history", requireAdmin, (req, res) => {
  res.json(q.all.all().map((s) => ({ ...s, results: results(s) })));
});

app.get("/api/export.csv", requireAdmin, (req, res) => {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ["type,id,statement_id,statement,variant,answer,rating,created_at_utc"];
  for (const r of q.export.all()) {
    lines.push(
      [r.type, r.id, r.statement_id, esc(r.statement), r.mode, r.answer ?? "", r.rating ?? "", r.created_at].join(",")
    );
  }
  res.type("text/csv").attachment("feedback-export.csv").send(lines.join("\n") + "\n");
});

app.listen(PORT, () => {
  console.log(`Kiosk: http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
});

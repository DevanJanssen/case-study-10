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

mkdirSync(path.join(__dirname, "data"), { recursive: true });
const db = new DatabaseSync(path.join(__dirname, "data", "feedback.db"));

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
`);

if (!db.prepare("SELECT 1 FROM statements LIMIT 1").get()) {
  db.prepare("INSERT INTO statements (text) VALUES (?)").run("Today's lesson was clear to me.");
}

const q = {
  current: db.prepare("SELECT id, text, created_at FROM statements ORDER BY id DESC LIMIT 1"),
  byId: db.prepare("SELECT id, text, created_at FROM statements WHERE id = ?"),
  insertStatement: db.prepare("INSERT INTO statements (text) VALUES (?)"),
  insertVote: db.prepare("INSERT INTO votes (statement_id, answer) VALUES (?, ?)"),
  counts: db.prepare(`
    SELECT
      COALESCE(SUM(answer = 'agree'), 0)    AS agree,
      COALESCE(SUM(answer = 'disagree'), 0) AS disagree
    FROM votes WHERE statement_id = ?`),
  history: db.prepare(`
    SELECT s.id, s.text, s.created_at,
      COALESCE(SUM(v.answer = 'agree'), 0)    AS agree,
      COALESCE(SUM(v.answer = 'disagree'), 0) AS disagree
    FROM statements s LEFT JOIN votes v ON v.statement_id = s.id
    GROUP BY s.id ORDER BY s.id DESC`),
  allVotes: db.prepare(`
    SELECT v.id, v.statement_id, s.text AS statement, v.answer, v.created_at
    FROM votes v JOIN statements s ON s.id = v.statement_id
    ORDER BY v.id`),
};

function results(statementId) {
  const { agree, disagree } = q.counts.get(statementId);
  const total = agree + disagree;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return { statementId, agree, disagree, total, agreePct: pct(agree), disagreePct: pct(disagree) };
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
  if (!text || text.length > 300) {
    return res.status(400).json({ error: "Statement must be 1–300 characters" });
  }
  const { lastInsertRowid } = q.insertStatement.run(text);
  res.status(201).json(q.byId.get(lastInsertRowid));
});

app.post("/api/votes", (req, res) => {
  const statementId = Number(req.body?.statementId);
  const answer = req.body?.answer;
  if (!["agree", "disagree"].includes(answer)) {
    return res.status(400).json({ error: 'answer must be "agree" or "disagree"' });
  }
  if (!Number.isInteger(statementId) || !q.byId.get(statementId)) {
    return res.status(400).json({ error: "Unknown statementId" });
  }
  q.insertVote.run(statementId, answer);
  res.status(201).json(results(statementId));
});

app.get("/api/results", (req, res) => {
  const statementId = req.query.statementId ? Number(req.query.statementId) : q.current.get().id;
  if (!Number.isInteger(statementId) || !q.byId.get(statementId)) {
    return res.status(404).json({ error: "Unknown statementId" });
  }
  res.json(results(statementId));
});

app.get("/api/history", requireAdmin, (req, res) => {
  res.json(q.history.all());
});

app.get("/api/export.csv", requireAdmin, (req, res) => {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ["vote_id,statement_id,statement,answer,created_at_utc"];
  for (const r of q.allVotes.all()) {
    lines.push([r.id, r.statement_id, esc(r.statement), r.answer, r.created_at].join(","));
  }
  res.type("text/csv").attachment("feedback-votes.csv").send(lines.join("\n") + "\n");
});

app.listen(PORT, () => {
  console.log(`Kiosk: http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
});

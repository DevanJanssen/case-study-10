import express from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, initSchema, DATABASE_URL, VARIANTS, RATING_VARIANTS } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD not set, using the default "admin". Set it before real use.');
}

// --- Database -------------------------------------------------------------

try {
  await initSchema();
} catch (err) {
  const { host, port, pathname } = new URL(DATABASE_URL);
  console.error(`❌ Cannot use Postgres at ${host}${port ? "" : ":5432"}${pathname}: ${err.message}`);
  console.error("   Start it with `docker compose up -d`, or point DATABASE_URL at another database.");
  process.exit(1);
}

const percent = (n, total) => (total ? Math.round((n / total) * 100) : 0);

/** Turn grouped answer counts ({answer, rating, n} rows) for one variant into results. */
function summarize(variant, rows) {
  if (RATING_VARIANTS.includes(variant)) {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const { rating, n } of rows) counts[rating] = n;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const sum = Object.entries(counts).reduce((a, [rating, n]) => a + rating * n, 0);
    const pct = Object.fromEntries(Object.entries(counts).map(([rating, n]) => [rating, percent(n, total)]));
    const average = total ? Math.round((sum / total) * 10) / 10 : 0;
    return { variant, total, average, counts, pct };
  }

  const count = (answer) => rows.find((r) => r.answer === answer)?.n ?? 0;
  const agree = count("agree");
  const disagree = count("disagree");
  const total = agree + disagree;
  return {
    variant, agree, disagree, total,
    agreePct: percent(agree, total),
    disagreePct: percent(disagree, total),
  };
}

const countAnswers = (questionId = null) =>
  pool.query(
    `SELECT question_id, variant, answer, rating, count(*)::int AS n
     FROM answers WHERE $1::int IS NULL OR question_id = $1
     GROUP BY question_id, variant, answer, rating`,
    [questionId]
  ).then((r) => r.rows);

/** Results for every variant the question is assigned to or has answers in. */
function questionResults(question, rows) {
  const results = {};
  for (const variant of VARIANTS) {
    const mine = rows.filter((r) => r.variant === variant);
    if (question.variants.includes(variant) || mine.length) results[variant] = summarize(variant, mine);
  }
  return results;
}

async function activeVariant() {
  const { rows } = await pool.query("SELECT active_variant FROM settings");
  return rows[0].active_variant;
}

/** A positive Postgres integer id, or null. */
function toId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= 2 ** 31 - 1 ? id : null;
}

/** Validate {text, variants} from the admin page. Fields left out are not checked. */
function questionError({ text, variants }) {
  if (text !== undefined && (typeof text !== "string" || !text.trim() || text.trim().length > 300)) {
    return "Question must be 1–300 characters";
  }
  if (variants !== undefined && (!Array.isArray(variants) || !variants.every((v) => VARIANTS.includes(v)))) {
    return `variants must be a list of: ${VARIANTS.join(", ")}`;
  }
  return null;
}

// Keeps the variants in a fixed order without duplicates.
const cleanVariants = (variants) => variants && VARIANTS.filter((v) => variants.includes(v));

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

// --- Kiosk ----------------------------------------------------------------

// The active variant and every question assigned to it. The kiosk shows them one at a time, in random order.
app.get("/api/kiosk", async (req, res) => {
  const variant = await activeVariant();
  const { rows } = await pool.query(
    "SELECT id, text FROM questions WHERE $1 = ANY (variants) ORDER BY id",
    [variant]
  );
  res.json({ variant, questions: rows });
});

// Thumbs answers take {answer}, star and finger answers take {rating}.
app.post("/api/answers", async (req, res) => {
  const questionId = toId(req.body?.questionId);
  const variant = req.body?.variant;
  if (!VARIANTS.includes(variant)) {
    return res.status(400).json({ error: `variant must be one of: ${VARIANTS.join(", ")}` });
  }

  let answer = null;
  let rating = null;
  if (RATING_VARIANTS.includes(variant)) {
    rating = req.body?.rating;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "rating must be a whole number from 1 to 5" });
    }
  } else {
    answer = req.body?.answer;
    if (!["agree", "disagree"].includes(answer)) {
      return res.status(400).json({ error: 'answer must be "agree" or "disagree"' });
    }
  }

  const { rowCount } = await pool.query(
    `INSERT INTO answers (question_id, variant, answer, rating)
     SELECT id, $2::text, $3::text, $4::smallint FROM questions WHERE id = $1`,
    [questionId, variant, answer, rating]
  );
  if (!rowCount) return res.status(400).json({ error: "Unknown questionId" });

  const rows = await countAnswers(questionId);
  res.status(201).json(summarize(variant, rows.filter((r) => r.variant === variant)));
});

// --- Admin ----------------------------------------------------------------

app.get("/api/variant", async (req, res) => {
  res.json({ variant: await activeVariant() });
});

app.put("/api/variant", requireAdmin, async (req, res) => {
  const variant = req.body?.variant;
  if (!VARIANTS.includes(variant)) {
    return res.status(400).json({ error: `variant must be one of: ${VARIANTS.join(", ")}` });
  }
  await pool.query("UPDATE settings SET active_variant = $1", [variant]);
  res.json({ variant });
});

// All questions, newest first, with their results per variant.
app.get("/api/questions", requireAdmin, async (req, res) => {
  const [{ rows: questions }, counts] = await Promise.all([
    pool.query("SELECT id, text, variants, created_at FROM questions ORDER BY created_at DESC, id DESC"),
    countAnswers(),
  ]);
  res.json(
    questions.map((q) => ({ ...q, results: questionResults(q, counts.filter((r) => r.question_id === q.id)) }))
  );
});

app.post("/api/questions", requireAdmin, async (req, res) => {
  const { text, variants = [] } = req.body ?? {};
  const error = questionError({ text: text ?? "", variants });
  if (error) return res.status(400).json({ error });

  const { rows: [question] } = await pool.query(
    "INSERT INTO questions (text, variants) VALUES ($1, $2) RETURNING id, text, variants, created_at",
    [text.trim(), cleanVariants(variants)]
  );
  res.status(201).json({ ...question, results: questionResults(question, []) });
});

app.patch("/api/questions/:id", requireAdmin, async (req, res) => {
  const { text, variants } = req.body ?? {};
  const error = questionError({ text, variants });
  if (error) return res.status(400).json({ error });

  const id = toId(req.params.id);
  const { rows: [question] } = await pool.query(
    `UPDATE questions SET text = COALESCE($2, text), variants = COALESCE($3::text[], variants)
     WHERE id = $1 RETURNING id, text, variants, created_at`,
    [id, text?.trim() ?? null, cleanVariants(variants) ?? null]
  );
  if (!question) return res.status(404).json({ error: "Unknown question" });
  res.json({ ...question, results: questionResults(question, await countAnswers(id)) });
});

// Deleting a question deletes its answers too.
app.delete("/api/questions/:id", requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM questions WHERE id = $1", [toId(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: "Unknown question" });
  res.status(204).end();
});

// Every answer to one question, newest first.
app.get("/api/questions/:id/answers", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, variant, answer, rating, created_at FROM answers WHERE question_id = $1 ORDER BY created_at DESC, id DESC",
    [toId(req.params.id)]
  );
  res.json(rows);
});

app.get("/api/export.csv", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT a.id, a.question_id, q.text AS question, a.variant, a.answer, a.rating, a.created_at
    FROM answers a JOIN questions q ON q.id = a.question_id
    ORDER BY a.created_at, a.id`);
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = ["answer_id,question_id,question,variant,answer,rating,created_at_utc"];
  for (const r of rows) {
    lines.push(
      [r.id, r.question_id, esc(r.question), r.variant, r.answer ?? "", r.rating ?? "", r.created_at.toISOString()].join(",")
    );
  }
  res.type("text/csv").attachment("feedback-export.csv").send(lines.join("\n") + "\n");
});

app.use((err, req, res, next) => {
  if (!err.expose) console.error(err);
  res.status(err.status ?? 500).json({ error: err.expose ? err.message : "Server error" });
});

app.listen(PORT, () => {
  console.log(`Kiosk: http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
});

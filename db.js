import pg from "pg";

// Matches docker-compose.yml. Set DATABASE_URL to use another Postgres.
export const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://feedback:feedback@localhost:5434/feedback";

export const VARIANTS = ["thumbs", "stars", "fingers"];
// Variants whose answer is a 1–5 rating rather than agree/disagree.
export const RATING_VARIANTS = ["stars", "fingers"];

export const pool = new pg.Pool({ connectionString: DATABASE_URL });

const variantList = VARIANTS.map((v) => `'${v}'`).join(", ");

/** Create the tables on first run. Safe to call on every start. */
export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions (
      id         serial      PRIMARY KEY,
      text       text        NOT NULL CHECK (char_length(text) BETWEEN 1 AND 300),
      -- Variants this question is asked in. Empty means it is parked and never shown.
      variants   text[]      NOT NULL DEFAULT '{}' CHECK (variants <@ ARRAY[${variantList}]::text[]),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS answers (
      id          serial      PRIMARY KEY,
      question_id integer     NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      variant     text        NOT NULL CHECK (variant IN (${variantList})),
      answer      text        CHECK (answer IN ('agree', 'disagree')),
      rating      smallint    CHECK (rating BETWEEN 1 AND 5),
      created_at  timestamptz NOT NULL DEFAULT now(),
      -- Thumbs answers are agree/disagree, the other variants are a 1–5 rating.
      CHECK ((variant = 'thumbs') = (answer IS NOT NULL) AND (answer IS NULL) = (rating IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS answers_question_idx ON answers (question_id, variant);

    -- A single row holding the variant the kiosk runs.
    CREATE TABLE IF NOT EXISTS settings (
      id             boolean PRIMARY KEY DEFAULT true CHECK (id),
      active_variant text    NOT NULL DEFAULT 'thumbs' CHECK (active_variant IN (${variantList}))
    );
    INSERT INTO settings DEFAULT VALUES ON CONFLICT DO NOTHING;
  `);
}

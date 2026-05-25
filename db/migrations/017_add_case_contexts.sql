CREATE TABLE IF NOT EXISTS case_contexts (
  case_base   TEXT PRIMARY KEY,
  exam_type   TEXT NOT NULL CHECK (exam_type IN ('AP', 'CITO')),
  subtipo     TEXT NOT NULL,
  sexo        TEXT NOT NULL CHECK (sexo IN ('F', 'M', 'outro')),
  idade       INT  NOT NULL CHECK (idade >= 0 AND idade <= 130),
  material    TEXT NOT NULL,
  hipotese    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

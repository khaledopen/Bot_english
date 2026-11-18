CREATE SCHEMA IF NOT EXISTS englishmate_web;
REVOKE ALL ON SCHEMA englishmate_web FROM PUBLIC;

CREATE TABLE IF NOT EXISTS englishmate_web.accounts (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  preferences jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS englishmate_web.sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES englishmate_web.accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS web_sessions_account ON englishmate_web.sessions(account_id);
CREATE INDEX IF NOT EXISTS web_sessions_expiry ON englishmate_web.sessions(expires_at);

CREATE TABLE IF NOT EXISTS englishmate_web.recovery_codes (
  code_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES englishmate_web.accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS web_recovery_account ON englishmate_web.recovery_codes(account_id);

CREATE TABLE IF NOT EXISTS englishmate_web.conversations (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES englishmate_web.accounts(id) ON DELETE CASCADE,
  title text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('text', 'voice')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_conversations_account ON englishmate_web.conversations(account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS englishmate_web.turns (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES englishmate_web.conversations(id) ON DELETE CASCADE,
  message text NOT NULL,
  reply text NOT NULL,
  spoken text NOT NULL,
  seconds integer NOT NULL DEFAULT 0 CHECK (seconds BETWEEN 0 AND 45),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_turns_conversation ON englishmate_web.turns(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS englishmate_web.vocabulary (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES englishmate_web.accounts(id) ON DELETE CASCADE,
  term text NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, term)
);

-- Niveau de chaque conversation (un changement de niveau ouvre une nouvelle conversation)
ALTER TABLE englishmate_web.conversations ADD COLUMN IF NOT EXISTS level text;
UPDATE englishmate_web.conversations c SET level = coalesce(a.preferences->>'level', 'intermediate')
  FROM englishmate_web.accounts a WHERE c.level IS NULL AND a.id = c.account_id;
-- Vocal de l'utilisateur, pour pouvoir le réécouter plus tard
ALTER TABLE englishmate_web.turns ADD COLUMN IF NOT EXISTS voice bytea;
ALTER TABLE englishmate_web.turns ADD COLUMN IF NOT EXISTS voice_type text;

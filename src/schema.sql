CREATE TABLE IF NOT EXISTS contacts (
  id          SERIAL PRIMARY KEY,
  phone       TEXT NOT NULL UNIQUE,      -- digits only, E.164 without '+'
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id          SERIAL PRIMARY KEY,
  contact_id  INTEGER NOT NULL UNIQUE REFERENCES contacts(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id                  SERIAL PRIMARY KEY,
  conversation_id     INTEGER NOT NULL REFERENCES conversations(id),
  whatsapp_message_id TEXT,
  direction           TEXT NOT NULL CHECK (direction IN ('in','out')),
  message_type        TEXT NOT NULL DEFAULT 'text',  -- text|template|image|document|video|audio|...
  body                TEXT,
  media               JSONB,                         -- reserved for future media metadata
  status              TEXT,                          -- sent|delivered|read|failed (out); received (in)
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deduplication: Meta retries webhooks, so a WhatsApp message id may only be stored once.
CREATE UNIQUE INDEX IF NOT EXISTS messages_wamid_uniq
  ON messages (whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conversation_id, created_at);

-- Canonical Flow-only conversations and ordered messages.
-- Uses the EXISTING OrdaX Platform PostgreSQL and auth.users identity.
-- NOT applied to production until Platform migration/role review.
-- Conversations are user-private; optional Platform project linking
-- remains a separate future authorization contract, never forged here.
BEGIN;
CREATE SCHEMA IF NOT EXISTS flow_private;
REVOKE ALL ON SCHEMA flow_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS flow_private.conversations (
  task_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS flow_conversations_owner_idx
  ON flow_private.conversations (owner_user_id, updated_at DESC, task_id DESC);

CREATE TABLE IF NOT EXISTS flow_private.messages (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES flow_private.conversations(task_id) ON DELETE CASCADE,
  request_id varchar(128) COLLATE "C" NOT NULL
    CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  role varchar(9) NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 96000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (task_id, request_id, role)
);
CREATE INDEX IF NOT EXISTS flow_messages_task_seq_idx
  ON flow_private.messages (task_id, seq DESC);

-- Harden the private schema even if administrators add new grants later.
ALTER TABLE flow_private.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_private.messages ENABLE ROW LEVEL SECURITY;
-- Least-privilege DB gateway is a NOLOGIN role; a trusted server login
-- must be explicitly granted membership by the Platform operator.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ordax_flow_gateway') THEN
    CREATE ROLE ordax_flow_gateway NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA flow_private TO ordax_flow_gateway;
GRANT SELECT,INSERT ON flow_private.conversations TO ordax_flow_gateway;
GRANT SELECT,INSERT ON flow_private.messages TO ordax_flow_gateway;
GRANT USAGE,SELECT ON SEQUENCE flow_private.messages_seq_seq TO ordax_flow_gateway;
ALTER TABLE flow_private.conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE flow_private.messages FORCE ROW LEVEL SECURITY;

-- The backend sets flow.owner_user_id via SET LOCAL in the same transaction
-- as every SQL statement. It MUST come from the verified OrdaX principal.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='flow_private'
    AND tablename='conversations' AND policyname='flow_conversation_owner') THEN
    CREATE POLICY flow_conversation_owner ON flow_private.conversations
      FOR ALL TO ordax_flow_gateway
      USING (owner_user_id = NULLIF(current_setting('flow.owner_user_id',true),'')::uuid)
      WITH CHECK (owner_user_id = NULLIF(current_setting('flow.owner_user_id',true),'')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='flow_private'
    AND tablename='messages' AND policyname='flow_message_owner') THEN
    CREATE POLICY flow_message_owner ON flow_private.messages
      FOR ALL TO ordax_flow_gateway
      USING (EXISTS (
        SELECT 1 FROM flow_private.conversations c
        WHERE c.task_id = messages.task_id
          AND c.owner_user_id = NULLIF(current_setting('flow.owner_user_id',true),'')::uuid
      ))
      WITH CHECK (EXISTS (
        SELECT 1 FROM flow_private.conversations c
        WHERE c.task_id = messages.task_id
          AND c.owner_user_id = NULLIF(current_setting('flow.owner_user_id',true),'')::uuid
      ));
  END IF;
END
$$;
REVOKE ALL ON flow_private.conversations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON flow_private.messages FROM PUBLIC, anon, authenticated;
COMMIT;

-- Only the authorized Flow central database role may query these tables.
-- The backend MUST filter by the verified owner on every statement.
-- Do not grant direct browser access; do not expose this schema to Data API.
-- No duplicate user account, project, Space, or memory table is created.

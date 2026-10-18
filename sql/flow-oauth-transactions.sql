-- Flow OAuth PKCE transactions in the EXISTING canonical Platform PostgreSQL.
-- REVIEW ONLY: do not apply to production until the Flow runtime/DB role
-- and canonical auth callbacks are provisioned. No new identity tables.
--
-- The flow_private schema is NOT exposed through the Supabase Data API.
-- Grant usage/table permissions only to the dedicated authorized
-- central gateway DB role, never anon/authenticated/PUBLIC.
BEGIN;
CREATE SCHEMA IF NOT EXISTS flow_private;
REVOKE ALL ON SCHEMA flow_private FROM PUBLIC;

CREATE TABLE IF NOT EXISTS flow_private.oauth_transactions (
  state_digest varchar(43) COLLATE "C" PRIMARY KEY,
  code_verifier varchar(128) COLLATE "C" NOT NULL,
  return_path varchar(7) NOT NULL
    CHECK (return_path IN ('/client', '/hub')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT flow_oauth_digest_check CHECK (state_digest ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT flow_oauth_verifier_check CHECK (code_verifier ~ '^[A-Za-z0-9_-]{43,128}$'),
  CONSTRAINT flow_oauth_max_lifetime_check CHECK (
    expires_at <= created_at + interval '10 minutes'
    AND expires_at > created_at
  )
);
REVOKE ALL ON flow_private.oauth_transactions FROM PUBLIC;
CREATE INDEX IF NOT EXISTS flow_oauth_expiry_idx
  ON flow_private.oauth_transactions (expires_at);
COMMIT;

-- Optional maintenance, executed as an authorized, rate-limited scheduled
-- backend job, not by a browser and not on every request:
-- DELETE FROM flow_private.oauth_transactions
-- WHERE expires_at < CURRENT_TIMESTAMP - interval '1 hour';

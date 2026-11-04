-- Optional Google identity; existing password and Feishu sessions remain compatible.
ALTER TABLE admin_users ADD COLUMN google_sub text UNIQUE;
ALTER TABLE admin_sessions ADD COLUMN auth_provider text NOT NULL DEFAULT 'legacy'
  CHECK (auth_provider IN ('legacy', 'google'));
ALTER TABLE admin_sessions ADD COLUMN google_email text;
ALTER TABLE admin_sessions ADD CONSTRAINT google_session_identity
  CHECK ((auth_provider = 'google') = (google_email IS NOT NULL));

CREATE TABLE admin_google_login_attempts (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  code_verifier text NOT NULL,
  nonce text NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX admin_google_login_attempts_expiry ON admin_google_login_attempts (expires_at);

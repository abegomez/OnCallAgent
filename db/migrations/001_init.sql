CREATE TABLE runs (
  id UUID PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  result JSONB,
  decision_lock_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT runs_state_check CHECK (
    state IN (
      'RECEIVED',
      'INVESTIGATING',
      'AWAITING_APPROVAL',
      'EXECUTED',
      'REJECTED',
      'FAILED'
    )
  )
);

CREATE INDEX runs_created_at_idx ON runs (created_at DESC);
CREATE INDEX runs_state_created_at_idx ON runs (state, created_at DESC);

CREATE TABLE run_transitions (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT run_transitions_from_state_check CHECK (
    from_state IS NULL OR from_state IN (
      'RECEIVED',
      'INVESTIGATING',
      'AWAITING_APPROVAL',
      'EXECUTED',
      'REJECTED',
      'FAILED'
    )
  ),
  CONSTRAINT run_transitions_to_state_check CHECK (
    to_state IN (
      'RECEIVED',
      'INVESTIGATING',
      'AWAITING_APPROVAL',
      'EXECUTED',
      'REJECTED',
      'FAILED'
    )
  )
);

CREATE INDEX run_transitions_run_id_idx ON run_transitions (run_id, id);

CREATE TABLE jobs (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE REFERENCES runs (id) ON DELETE CASCADE,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jobs_attempts_check CHECK (attempts >= 0 AND max_attempts > 0)
);

CREATE INDEX jobs_claim_idx ON jobs (available_at, id)
  WHERE completed_at IS NULL;

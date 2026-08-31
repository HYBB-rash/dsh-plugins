/** Stable SQLite identity for the current online store. */
export const ASSISTANT_APPLICATION_ID = 0x44534841

/** Current on-disk schema accepted by the running assistant. */
export const ASSISTANT_SCHEMA_VERSION = 4

/**
 * Independent projection of assistant intent and manager run observations.
 * The table intentionally does not reuse commitment progress or outbox
 * delivery columns: those columns belong to the assistant's own lifecycle.
 */
export const ASSISTANT_CRON_BINDINGS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS assistant_cron_bindings (
    commitment_id TEXT PRIMARY KEY REFERENCES commitments(id),
    external_ref TEXT NOT NULL UNIQUE,
    desired_schedule_json TEXT NOT NULL,
    desired_cwd TEXT,
    desired_state TEXT NOT NULL CHECK (desired_state IN ('running','paused','cancelled')),
    bound_job_id TEXT,
    last_run_id TEXT,
    last_run_job_id TEXT,
    scheduled_for TEXT,
    finished_at TEXT,
    run_status TEXT CHECK (run_status IS NULL OR run_status IN ('success','error','expired','interrupted')),
    last_run_summary TEXT,
    run_error TEXT,
    delivery_state TEXT CHECK (delivery_state IS NULL OR delivery_state IN ('delivered','silent','not_requested','failed','uncertain')),
    delivery_error TEXT,
    control_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS assistant_cron_bindings_bound_job_id
    ON assistant_cron_bindings(bound_job_id) WHERE bound_job_id IS NOT NULL;
`

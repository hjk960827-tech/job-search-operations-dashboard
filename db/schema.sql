PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('native', 'legacy_schema_version')),
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS system_revisions (
  scope TEXT PRIMARY KEY CHECK(scope IN ('jobs', 'workflow')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS privacy_deletion_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL,
  document_kind TEXT NOT NULL,
  document_sha256 TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('deleted', 'quarantined')),
  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('collect_jobs', 'analyze_documents', 'generate_package')),
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  dedupe_key TEXT NOT NULL,
  request_checksum TEXT NOT NULL,
  result_checksum TEXT NOT NULL DEFAULT '',
  request_path TEXT NOT NULL,
  result_path TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_task_reviews (
  task_id TEXT PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'awaiting_review'
    CHECK(status IN ('awaiting_review', 'accepted', 'rejected', 'superseded')),
  result_checksum TEXT NOT NULL,
  preview_json TEXT NOT NULL DEFAULT '{}',
  decision_json TEXT NOT NULL DEFAULT '{}',
  application_kind TEXT NOT NULL DEFAULT '',
  application_ref TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  title TEXT NOT NULL,
  track TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  employment_type TEXT NOT NULL DEFAULT '',
  lifecycle_status TEXT NOT NULL DEFAULT 'unknown',
  deadline TEXT,
  deadline_source TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  reopened_at TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0 CHECK(reopen_count >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS job_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  source_url TEXT NOT NULL,
  external_id TEXT NOT NULL DEFAULT '',
  lifecycle_status TEXT NOT NULL DEFAULT 'unknown',
  deadline TEXT,
  confidence INTEGER NOT NULL DEFAULT 0 CHECK(confidence BETWEEN 0 AND 100),
  access_method TEXT NOT NULL DEFAULT 'manual'
    CHECK(access_method IN ('official_api', 'public_page', 'manual', 'user_agent', 'import')),
  provenance_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, platform, source_url)
);

CREATE TABLE IF NOT EXISTS job_scores (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  total_score REAL,
  breakdown_json TEXT NOT NULL DEFAULT '{}',
  score_mode TEXT NOT NULL DEFAULT 'scalar' CHECK(score_mode IN ('none', 'scalar', 'breakdown')),
  profile_checksum TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS application_state (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1)),
  workflow_status TEXT NOT NULL DEFAULT 'new'
    CHECK(workflow_status IN ('new', 'reviewing', 'skipped', 'applied', 'interview', 'offer', 'rejected')),
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resume_profile (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  job_family TEXT NOT NULL DEFAULT '',
  job_role TEXT NOT NULL DEFAULT '',
  career_type TEXT NOT NULL DEFAULT 'new' CHECK(career_type IN ('new', 'experienced')),
  career_stage TEXT NOT NULL DEFAULT '',
  years_experience REAL,
  school TEXT NOT NULL DEFAULT '',
  major TEXT NOT NULL DEFAULT '',
  headline TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  skills_json TEXT NOT NULL DEFAULT '[]',
  certificates_json TEXT NOT NULL DEFAULT '[]',
  experience_highlights_json TEXT NOT NULL DEFAULT '[]',
  achievement_evidence TEXT NOT NULL DEFAULT '',
  representative_experience TEXT NOT NULL DEFAULT '',
  direct_scope TEXT NOT NULL DEFAULT '',
  collaboration_scope TEXT NOT NULL DEFAULT '',
  career_direction TEXT NOT NULL DEFAULT '',
  editable_sections_json TEXT NOT NULL DEFAULT '["headline","summary","skills","experience_highlights","achievement_evidence","representative_experience","direct_scope","collaboration_scope","career_direction"]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('resume', 'portfolio', 'manual')),
  original_name TEXT NOT NULL DEFAULT '',
  internal_path TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0),
  sha256 TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resume_assets (
  document_id TEXT PRIMARY KEY REFERENCES source_documents(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'review_required', 'archived')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resume_structured_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('experience', 'education', 'skill', 'certification', 'project')),
  title TEXT NOT NULL,
  organization TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  highlights_json TEXT NOT NULL DEFAULT '[]',
  skills_json TEXT NOT NULL DEFAULT '[]',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  display_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS profile_facts (
  id TEXT PRIMARY KEY,
  fact_key TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  source_document_id TEXT REFERENCES source_documents(id) ON DELETE SET NULL,
  source_locator TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0 CHECK(confidence BETWEEN 0 AND 100),
  protected INTEGER NOT NULL DEFAULT 1 CHECK(protected IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metrics_json TEXT NOT NULL DEFAULT '[]',
  skills_json TEXT NOT NULL DEFAULT '[]',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resume_custom_sections (
  id TEXT PRIMARY KEY,
  section_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text', 'list')),
  value_json TEXT NOT NULL DEFAULT '""',
  display_order INTEGER NOT NULL DEFAULT 0,
  editable INTEGER NOT NULL DEFAULT 1 CHECK(editable IN (0, 1)),
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS job_tailoring (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  focus_sections_json TEXT NOT NULL DEFAULT '[]',
  application_questions_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS application_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'quality_hold'
    CHECK(state IN ('quality_hold', 'approval_pending', 'approved', 'submit_ready', 'submitted')),
  content_json TEXT NOT NULL DEFAULT '{}',
  content_checksum TEXT NOT NULL,
  base_resume_fingerprint TEXT NOT NULL DEFAULT '',
  job_input_fingerprint TEXT NOT NULL DEFAULT '',
  quality_rules_fingerprint TEXT NOT NULL DEFAULT '',
  quality_rules_json TEXT NOT NULL DEFAULT '{}',
  supersedes_package_id INTEGER REFERENCES application_packages(id) ON DELETE SET NULL,
  quality_status TEXT NOT NULL DEFAULT 'review',
  quality_score REAL NOT NULL DEFAULT 0,
  quality_findings_json TEXT NOT NULL DEFAULT '[]',
  artifact_directory TEXT NOT NULL,
  content_json_path TEXT NOT NULL,
  resume_markdown_path TEXT NOT NULL,
  resume_html_path TEXT NOT NULL,
  application_answers_path TEXT NOT NULL DEFAULT '',
  resume_pdf_path TEXT NOT NULL DEFAULT '',
  resume_pdf_checksum TEXT NOT NULL DEFAULT '',
  resume_pdf_pages INTEGER NOT NULL DEFAULT 0,
  approved_checksum TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, version)
);

CREATE TABLE IF NOT EXISTS package_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL REFERENCES application_packages(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  actor_id TEXT NOT NULL DEFAULT 'local-user',
  previous_checksum TEXT NOT NULL,
  next_checksum TEXT NOT NULL,
  previous_content_json TEXT NOT NULL,
  next_content_json TEXT NOT NULL,
  snapshot_directory TEXT NOT NULL,
  quality_status TEXT NOT NULL,
  quality_score REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(package_id, revision_no)
);

CREATE TABLE IF NOT EXISTS package_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL REFERENCES application_packages(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('approved', 'invalidated')),
  package_checksum TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT 'local-user',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS package_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL UNIQUE REFERENCES application_packages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('submit_ready', 'submitted')),
  platform TEXT NOT NULL DEFAULT '',
  frozen_pdf_path TEXT NOT NULL,
  frozen_pdf_checksum TEXT NOT NULL,
  frozen_pdf_pages INTEGER NOT NULL,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS application_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  dedupe_key TEXT NOT NULL UNIQUE,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  package_id INTEGER REFERENCES application_packages(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'document_passed', 'document_rejected', 'interview_scheduled',
    'interview_completed', 'offer_received', 'offer_accepted',
    'rejected', 'withdrawn'
  )),
  summary TEXT NOT NULL DEFAULT '',
  evidence_kind TEXT NOT NULL DEFAULT 'none'
    CHECK(evidence_kind IN ('none', 'manual_note', 'portal', 'email', 'document')),
  evidence_label TEXT NOT NULL DEFAULT '',
  evidence_checksum TEXT NOT NULL DEFAULT '',
  correction_of_event_id INTEGER REFERENCES application_events(id),
  correction_reason TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS follow_ups (
  id TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_event_id INTEGER REFERENCES application_events(id),
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,
  offset_days INTEGER CHECK(offset_days BETWEEN 0 AND 365),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'cancelled')),
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS local_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_key TEXT NOT NULL UNIQUE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES application_events(id),
  follow_up_id TEXT REFERENCES follow_ups(id),
  notification_type TEXT NOT NULL CHECK(notification_type IN ('outcome', 'follow_up')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  deep_link TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS saved_filters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  filter_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_jobs_track ON jobs(track);
CREATE INDEX IF NOT EXISTS idx_jobs_deadline ON jobs(deadline, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_job_sources_job ON job_sources(job_id);
CREATE INDEX IF NOT EXISTS idx_job_sources_platform ON job_sources(platform);
CREATE INDEX IF NOT EXISTS idx_job_sources_deadline ON job_sources(deadline, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_profile_facts_key ON profile_facts(fact_key);
CREATE INDEX IF NOT EXISTS idx_resume_custom_sections_order ON resume_custom_sections(display_order, section_key);
CREATE INDEX IF NOT EXISTS idx_resume_assets_status ON resume_assets(status, document_id);
CREATE INDEX IF NOT EXISTS idx_resume_structured_kind_order ON resume_structured_items(kind, display_order, id);
CREATE INDEX IF NOT EXISTS idx_application_packages_job ON application_packages(job_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_package_revisions_package ON package_revisions(package_id, revision_no DESC);
CREATE INDEX IF NOT EXISTS idx_package_approvals_package ON package_approvals(package_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_privacy_deletion_events_document ON privacy_deletion_events(document_id, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_created ON agent_tasks(status, created_at, id);
CREATE INDEX IF NOT EXISTS idx_agent_task_reviews_status_updated ON agent_task_reviews(status, updated_at, task_id);
CREATE INDEX IF NOT EXISTS idx_application_events_job_occurred ON application_events(job_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_application_events_correction ON application_events(correction_of_event_id, id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_job_due ON follow_ups(job_id, status, due_at, id);
CREATE INDEX IF NOT EXISTS idx_local_notifications_unread ON local_notifications(read_at, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_saved_filters_default_name ON saved_filters(is_default DESC, name_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_follow_ups_pending_dedupe
  ON follow_ups(job_id, dedupe_key) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_active_dedupe
  ON agent_tasks(kind, dedupe_key) WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tasks_single_generation
  ON agent_tasks((1)) WHERE kind = 'generate_package' AND status = 'running';

CREATE TRIGGER IF NOT EXISTS application_events_update_guard
BEFORE UPDATE ON application_events
BEGIN SELECT RAISE(ABORT, 'application events are append-only'); END;

CREATE TRIGGER IF NOT EXISTS application_events_delete_guard
BEFORE DELETE ON application_events
BEGIN SELECT RAISE(ABORT, 'application events are append-only'); END;

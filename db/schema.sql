PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
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
  summary TEXT NOT NULL DEFAULT '',
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
  confidence INTEGER NOT NULL DEFAULT 0 CHECK(confidence BETWEEN 0 AND 100),
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, platform, source_url)
);

CREATE TABLE IF NOT EXISTS job_scores (
  job_id INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  total_score REAL,
  breakdown_json TEXT NOT NULL DEFAULT '{}',
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
  headline TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  skills_json TEXT NOT NULL DEFAULT '[]',
  experience_highlights_json TEXT NOT NULL DEFAULT '[]',
  filename_pattern TEXT NOT NULL DEFAULT '{name}_resume_{company}.pdf',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS application_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'quality_hold'
    CHECK(state IN ('quality_hold', 'approval_pending', 'revision_requested', 'approval_hold', 'approved', 'submit_ready', 'submitted', 'archived')),
  content_json TEXT NOT NULL DEFAULT '{}',
  content_checksum TEXT NOT NULL,
  quality_status TEXT NOT NULL DEFAULT 'review',
  quality_score REAL NOT NULL DEFAULT 0,
  quality_findings_json TEXT NOT NULL DEFAULT '[]',
  artifact_directory TEXT NOT NULL,
  content_json_path TEXT NOT NULL,
  resume_markdown_path TEXT NOT NULL,
  resume_html_path TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_jobs_track ON jobs(track);
CREATE INDEX IF NOT EXISTS idx_job_sources_job ON job_sources(job_id);
CREATE INDEX IF NOT EXISTS idx_job_sources_platform ON job_sources(platform);
CREATE INDEX IF NOT EXISTS idx_application_packages_job ON application_packages(job_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_package_revisions_package ON package_revisions(package_id, revision_no DESC);
CREATE INDEX IF NOT EXISTS idx_package_approvals_package ON package_approvals(package_id, created_at DESC);

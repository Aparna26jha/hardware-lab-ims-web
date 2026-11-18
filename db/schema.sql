-- Hardware Lab IMS - MySQL 8 schema.
-- Safe to run more than once: every table is created only if it is missing.

CREATE TABLE IF NOT EXISTS teams (
  team_id      INT AUTO_INCREMENT PRIMARY KEY,
  team_name    VARCHAR(80)  NOT NULL,
  lead_emp_id  VARCHAR(32)  NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_team_name (team_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS users (
  emp_id          VARCHAR(32)  NOT NULL PRIMARY KEY,
  emp_name        VARCHAR(120) NOT NULL,
  email           VARCHAR(120) NOT NULL,
  role            ENUM('Super Admin','Admin','Lead Admin','User') NOT NULL DEFAULT 'User',
  requested_role  ENUM('Super Admin','Admin','Lead Admin','User') NOT NULL DEFAULT 'User',
  team_id         INT          NULL,
  approval        ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
  active          TINYINT(1)   NOT NULL DEFAULT 0,
  access_hash     VARCHAR(200) NOT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_email (email),
  CONSTRAINT fk_user_team FOREIGN KEY (team_id) REFERENCES teams (team_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- People who are allowed to request access (the lab directory).
CREATE TABLE IF NOT EXISTS directory (
  alias       VARCHAR(32)  NOT NULL PRIMARY KEY,
  email       VARCHAR(120) NOT NULL,
  emp_name    VARCHAR(120) NOT NULL,
  team_id     INT          NULL,
  added_by    VARCHAR(32)  NULL,
  added_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_directory_email (email),
  CONSTRAINT fk_directory_team FOREIGN KEY (team_id) REFERENCES teams (team_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per package or delivery: invoice, PO, date and how many items came in it.
CREATE TABLE IF NOT EXISTS consignments (
  consignment_id  INT AUTO_INCREMENT PRIMARY KEY,
  invoice_no      VARCHAR(64)  NOT NULL,
  po_number       VARCHAR(64)  NOT NULL,
  received_date   DATE         NOT NULL,
  expected_items  INT          NOT NULL,
  ownership       ENUM('AMD-Specific','Wipro-Specific') NOT NULL,
  supplier        VARCHAR(120) NULL,
  remarks         VARCHAR(500) NULL,
  created_by      VARCHAR(32)  NOT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_invoice_po (invoice_no, po_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS consignment_documents (
  doc_id          INT AUTO_INCREMENT PRIMARY KEY,
  consignment_id  INT          NOT NULL,
  original_name   VARCHAR(200) NOT NULL,
  stored_name     VARCHAR(100) NOT NULL,
  mime_type       VARCHAR(60)  NOT NULL,
  size_bytes      INT          NOT NULL,
  uploaded_by     VARCHAR(32)  NOT NULL,
  uploaded_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_doc_consignment FOREIGN KEY (consignment_id) REFERENCES consignments (consignment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS assets (
  barcode         VARCHAR(64)  NOT NULL PRIMARY KEY,
  ownership       ENUM('AMD-Specific','Wipro-Specific') NOT NULL,
  asset_type      VARCHAR(40)  NOT NULL,
  manufacturer    VARCHAR(80)  NULL,
  mfs_serial_no   VARCHAR(80)  NULL,
  make            VARCHAR(80)  NULL,
  model           VARCHAR(80)  NULL,
  capacity_rev    VARCHAR(80)  NULL,
  description     VARCHAR(500) NULL,
  po_number       VARCHAR(64)  NULL,
  bond_no         VARCHAR(40)  NULL,
  arrival_date    DATE         NULL,
  expiry_date     DATE         NULL,
  storage_room    VARCHAR(40)  NULL,
  location        VARCHAR(80)  NULL,
  status          ENUM('Available in Lab','Assigned to Engineer','Under Maintenance','Scrapped/Returned') NOT NULL DEFAULT 'Available in Lab',
  holder_emp_id   VARCHAR(32)  NULL,
  consignment_id  INT          NULL,
  revision        INT          NOT NULL DEFAULT 0,
  created_by      VARCHAR(32)  NOT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      DATETIME     NULL,
  deleted_by      VARCHAR(32)  NULL,
  delete_reason   VARCHAR(300) NULL,
  UNIQUE KEY uq_asset_serial (mfs_serial_no),
  KEY ix_asset_holder (holder_emp_id),
  KEY ix_asset_consignment (consignment_id),
  CONSTRAINT fk_asset_consignment FOREIGN KEY (consignment_id) REFERENCES consignments (consignment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every inward, edit, transfer, delete and restore. Rows are only ever added.
CREATE TABLE IF NOT EXISTS audit_log (
  log_id       BIGINT AUTO_INCREMENT PRIMARY KEY,
  logged_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  barcode      VARCHAR(64)  NOT NULL,
  action       ENUM('Inward','Edit','Transfer','Delete','Restore') NOT NULL,
  from_holder  VARCHAR(32)  NULL,
  to_holder    VARCHAR(32)  NULL,
  from_status  VARCHAR(40)  NULL,
  to_status    VARCHAR(40)  NULL,
  done_by      VARCHAR(32)  NOT NULL,
  remarks      VARCHAR(500) NULL,
  KEY ix_audit_barcode (barcode),
  KEY ix_audit_time (logged_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS feedback (
  feedback_id      INT AUTO_INCREMENT PRIMARY KEY,
  kind             ENUM('Issue','Improvement','Bug','Suggestion','Others') NOT NULL,
  title            VARCHAR(150) NOT NULL,
  description      TEXT         NOT NULL,
  screen           VARCHAR(40)  NULL,
  screenshot_name  VARCHAR(100) NULL,
  screenshot_mime  VARCHAR(60)  NULL,
  emp_id           VARCHAR(32)  NOT NULL,
  emp_name         VARCHAR(120) NOT NULL,
  email            VARCHAR(120) NOT NULL,
  role             VARCHAR(20)  NOT NULL,
  status           ENUM('New','In review','Done') NOT NULL DEFAULT 'New',
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- "I need hardware" or "please take this back". Approving one makes the transfer.
CREATE TABLE IF NOT EXISTS hardware_requests (
  request_id     INT AUTO_INCREMENT PRIMARY KEY,
  kind           ENUM('Need','Return') NOT NULL,
  emp_id         VARCHAR(32)  NOT NULL,
  asset_type     VARCHAR(40)  NULL,
  barcode        VARCHAR(64)  NULL,
  details        VARCHAR(500) NOT NULL DEFAULT '',
  status         ENUM('Open','Approved','Rejected','Cancelled') NOT NULL DEFAULT 'Open',
  decided_by     VARCHAR(32)  NULL,
  decided_at     DATETIME     NULL,
  decision_note  VARCHAR(300) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_request_status (status),
  KEY ix_request_emp (emp_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  CHAR(64)     NOT NULL PRIMARY KEY,
  emp_id      VARCHAR(32)  NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME     NOT NULL,
  KEY ix_session_emp (emp_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

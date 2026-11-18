# Hardware Lab IMS (web version)

An inventory management system for a semiconductor validation lab. It tracks AMD-Specific and Wipro-Specific hardware (motherboards, add-in cards, debuggers, SoC boards, power supplies, cables), who holds each item today, which team they belong to, and every move.

It runs as a service on one server. People open it in a browser using the server's address. Nothing is installed on user laptops.

- **Server:** Node.js (LTS) with Express
- **Database:** MySQL 8.4 LTS
- **Browser:** Edge or Chrome

## What it does

| Area | What you can do |
|---|---|
| Sign-in | Sign in with your alias ID or company mail ID and an access code. New people request access; a Super Admin approves them. |
| Dashboard | Count cards (select one to list exactly those items), a "Needs your attention" list, recent activity, an assets-by-team table, a searchable hardware list with filters, and CSV export. |
| Inward by consignment | Record the package first (invoice no., PO no., date, number of items, ownership). Upload the scanned invoice or delivery note. Then scan or type each item into it. PO and arrival date come from the consignment automatically. If the document has not arrived yet, tick **No document yet** and give the reason: it is saved in each item's history, and the consignment stays under "Needs your attention" until a document is uploaded. |
| AMD asset labels | AMD labels carry a Code 39 barcode `EMBLAB` + number (for example `EMBLAB30890`), a Bond No. and a description line. The IMS accepts them with or without the `*` start and stop marks, records the Bond No., and refuses an `EMBLAB` label in a Wipro-Specific consignment. |
| Barcode auto-fill | Scanning a new barcode fills the type, make, model, manufacturer, revision, description, Bond No. and storage place from the item scanned last into the same consignment (or, for barcodes like `MB-SP5-045`, from the latest item of the same family). Typing a known model fills its make and manufacturer. |
| Storage places | Free items are kept in the **2A Inventory Room** or the **Store Room**, with an optional cupboard or shelf. Assigned items show as **Lab (with the person's alias)**. |
| Transfer | Scan an item, choose the new status and the person receiving it. Its full history is shown beside it. |
| Asset details | See everything about one item; Admins edit details (every edit is logged). |
| Requests | Engineers and leads ask for hardware ("I need a debugger for MI300 bring-up") or ask the custodian to take back an item they hold. Admins see open requests in "Needs your attention". Approving makes the transfer and logs it (for a hardware request, the Admin enters the barcode of a free item from the cage). Rejecting needs a reason. The person sees the answer on their Requests screen and can cancel an open request. |
| Delete (Super Admin only) | A "soft delete": the item is hidden from every list and the deletion is logged with a reason. It can be restored from **Deleted assets**. |
| Teams | Super Admin creates teams and sets each team's Lead Admin. Every item shows the team of the person holding it. |
| Feedback | A **Give feedback** button on every screen. Type (Issue, Improvement, Bug, Suggestion, Others), title (at least 15 characters), description (at least 25 characters) and an optional screenshot. The name, mail ID, role and time are saved automatically. Admins and Super Admins see the list and mark items In review or Done. |
| Expiry | The expiry date is optional. Warnings start 6 months before it (`EXPIRY_WARN_MONTHS`). |
| Backups | Automatic daily backup, plus **Back up now** for the Super Admin. See [Backups](#backups). |

## Roles

| Role | Sees | Can do |
|---|---|---|
| Super Admin | Everything | Everything, plus approve accounts, roles and teams, the lab directory, delete and restore, backup |
| Admin | Everything | Inward, transfer, approve or reject requests, edit details, history, feedback list, exports |
| Lead Admin | Their own and their team's hardware (AMD and Wipro), plus items free in the cage | View and export, send requests; no history |
| User | Hardware assigned to them | View and export, send requests, change their access code |

## Development copy and production copy

The same code runs as two copies, each with its own folder, database, port and backup folder:

| | Development | Production |
|---|---|---|
| `APP_ENV` | `development` | `production` |
| Database | `ims_dev` | `ims_prod` |
| Sample data, sample sign-in buttons, Reset | Allowed | Switched off |

Testers work on the development copy. A tested version is then copied to production.

## Quick start (development copy)

You need Node.js 20.6 or later and MySQL 8.4.

1. Create the database and user (in the MySQL command line client, as root):
   ```sql
   CREATE DATABASE ims_dev CHARACTER SET utf8mb4;
   CREATE USER 'ims_app'@'localhost' IDENTIFIED BY 'choose-a-strong-password';
   GRANT ALL ON ims_dev.* TO 'ims_app'@'localhost';
   ```
2. In this folder:
   ```
   npm install
   copy .env.example .env      (then edit DB_PASSWORD and the folders)
   npm run init-db:sample
   npm start
   ```
3. Open `http://localhost:8080` and sign in as `SA001` with code `1001`.

For the full server set-up, with the service, firewall and backups, see [docs/DEPLOY_WINDOWS_SERVER.md](docs/DEPLOY_WINDOWS_SERVER.md).

If the server cannot download packages, use the `hardware-lab-ims-<version>-windows.zip` from **Releases**. It already contains `node_modules`, so `npm install` is not needed.

## Sample accounts (development copy only)

| Alias | Code | Role | Team |
|---|---|---|---|
| SA001 | 1001 | Super Admin | - |
| AD010 | 2001 | Admin | - |
| LD200 | 4001 | Lead Admin | IPSi (lead) |
| LD300 | 4002 | Lead Admin | Team B (sample) (lead) |
| EN1042 | 3001 | User | IPSi |
| EN1108 | 3002 | User | IPSi |
| EN1200 | 3004 | User | Team B (sample) |
| EN2301 | 3003 | User, waiting for approval | IPSi |
| EN2200 | - | On the directory only; use it to try **Request access** (mail `en2200@lab.example`, name `Sample New Engineer`) | IPSi |

The sample also has two open requests: EN1042 asks to return `PSU-2K4-021`, and EN1108 needs a debugger (approve it with `DBG-HDT-003` from the cage).

The sample has three consignments. `INV-AR-7741` is still open (1 of 4 items, no document yet) so you can try the inward steps: upload any PDF, then scan `MB-SP5-045` and watch the details fill in.

## Settings (`.env`)

| Setting | Meaning |
|---|---|
| `APP_ENV` | `development` or `production` |
| `PORT`, `HOST` | Web address port, for example `8080` |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | MySQL connection |
| `UPLOAD_DIR` | Where invoices, delivery notes and feedback screenshots are stored |
| `BACKUP_DIR`, `BACKUP_HOUR`, `BACKUP_KEEP_DAYS` | Daily backup folder, hour (0-23) and how many days to keep |
| `SESSION_HOURS` | How long a sign-in lasts |
| `COOKIE_SECURE` | `true` only when served over https |
| `EXPIRY_WARN_MONTHS` | Expiry warning window (default 6) |

The `.env` file holds the database password. It is never committed.

## Backups

No change is lost between backups:

1. **Every save is final at once.** MySQL writes each inward, transfer or edit to disk as it happens, and the asset row and its audit row are saved together or not at all.
2. **Binary log.** MySQL 8.4 keeps a binary log by default, so the database can be brought back to any minute.
3. **Daily app backup.** The IMS writes every table to a JSON file in `BACKUP_DIR` once a day (and on **Back up now**), copies new uploaded documents beside it, and keeps `BACKUP_KEEP_DAYS` days.
4. **Nightly MySQL dump.** `scripts\windows\mysql-backup.cmd` makes a full `.sql` copy for Task Scheduler.

Keep `BACKUP_DIR` on a different drive or a network share from the database.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Starts the IMS |
| `npm run init-db` | Creates any missing tables (safe to run again after an update) |
| `npm run init-db:sample` | The same, then loads the sample lab into an empty database |
| `npm run create-admin` | Adds the first Super Admin on a real (production) database |
| `npm run backup` | Takes one backup now |
| `npm test` | Runs the automated checks against the `ims_test` database |

## Folder layout

```
db/schema.sql          MySQL tables
src/server.js          Web server, security headers, error handling
src/routes/            API: people (sign-in, accounts, teams, directory), assets, consignments, requests, admin (dashboard, feedback, backup)
src/rules.js           Shared rules: roles, statuses, barcode and expiry checks
src/sample.js          Sample lab for the development copy
public/                The browser screens (index.html, app.js, app.css)
scripts/               Database set-up, first admin, backup, Windows helper scripts
test/                  Automated checks
docs/                  Server deployment guide
```

## Security notes

- Access codes are stored as salted scrypt hashes, never as plain text.
- Five wrong codes lock that sign-in for 10 minutes.
- Sign-in sessions are HttpOnly, SameSite=Strict cookies, and every change also needs a header that only this app's pages send.
- Every check runs on the server, so the browser cannot skip a rule.
- Uploads are checked by file content (PDF, JPG, PNG only) and stored under random names.
- The page blocks inline scripts and framing (Content Security Policy).

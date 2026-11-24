# Deploying the IMS on a Windows Server

This guide sets up the **development copy** on a Windows Server (2019, 2022 or 2025). The production copy uses the same steps with different names; see step 12.

At the end, anyone on the lab network opens `http://<server-ip>:8080` in Edge or Chrome.

## What you need first

| Item | Why |
|---|---|
| Remote Desktop access to the server, with an account that can install software | To install Node.js and MySQL |
| Internet on the server, or the installers copied onto it | Node.js, MySQL and the app's packages are downloaded once |
| Port 8080 allowed from the lab network to the server | So laptops can reach the IMS |
| A second drive or a network share for backups (for example `D:\IMS_Backups`) | Backups should not sit on the same disk as the database |

Never write the server or database passwords into this repository, a chat, or a document. Keep them with the person responsible for the server.

## Step 1: Connect to the server

On the office laptop, press the Windows key, type `mstsc`, and press Enter. Enter the server address, select **Connect**, and sign in.

Check the Windows version: press the Windows key, type `winver`, and press Enter. It should say Windows Server 2019, 2022 or 2025. Current Node.js and MySQL 8.4 do not install on older versions such as 2012 R2; in that case, ask IT for a newer server before going further.

## Step 2: Install Node.js

1. Download the **LTS** Windows Installer (`.msi`, 64-bit) from https://nodejs.org.
2. Run it and keep the default options.
3. Open a new **Command Prompt** and check the version:
   ```
   node -v
   npm -v
   ```
   You should see a version of 20.6 or later.

## Step 3: Install MySQL 8.4 LTS

1. Download **MySQL Community Server 8.4 LTS**, Windows MSI installer, from https://dev.mysql.com/downloads/mysql/.
2. Run it and choose **Typical**. When the configuration screen opens:
   - Config type: **Server Computer**. Port: **3306**.
   - Authentication: **strong password encryption** (the default).
   - Set a **root password** and store it safely.
   - Windows Service: keep **Configure MySQL Server as a Windows Service** ticked and **Start at System Startup** ticked. The service is named `MySQL84`.
3. Finish the installer.

## Step 4: Create the database and the app user

1. Start menu → **MySQL 8.4 Command Line Client**, then enter the root password.
2. Paste this, after replacing the password with a new strong one:
   ```sql
   CREATE DATABASE ims_dev CHARACTER SET utf8mb4;
   CREATE USER 'ims_app'@'localhost' IDENTIFIED BY 'replace-with-a-strong-password';
   GRANT ALL ON ims_dev.* TO 'ims_app'@'localhost';
   ```
3. Type `exit`.

The app signs in to MySQL as `ims_app`, which can only use the IMS database.

## Step 5: Put the app on the server

1. On the repository page, open **Releases** (right side) and download the newest `hardware-lab-ims-<version>-windows.zip`. It already contains the app's packages, so step 6 is not needed. (The green **Code** button → **Download ZIP** also works, but then step 6 is needed.)
2. Copy the zip to the server: copy it on the laptop, then paste it into a folder inside the Remote Desktop window. If pasting is blocked, ask IT how files are moved to the server.
3. On the server, right-click the zip → **Properties** → tick **Unblock** (if shown) → **OK**.
4. Extract it, and rename the inner folder so the app sits at `C:\IMS\ims-dev`. That folder should contain `package.json`, `src` and `public`.

If Git is installed, you can use `git clone <repository-url> C:\IMS\ims-dev` instead.

## Step 6: Download the app's packages

Skip this step if you used the Releases zip and `C:\IMS\ims-dev\node_modules` already exists.

In **Command Prompt**:

```
cd /d C:\IMS\ims-dev
npm install --omit=dev
```

This creates a `node_modules` folder. It downloads only two packages (Express and the MySQL driver) and the small packages they use.

If the server has no internet, run the same command on any computer with Node.js and internet access, then copy the `node_modules` folder into `C:\IMS\ims-dev`. The packages are plain JavaScript, so they work on any system.

If PowerShell says that running scripts is disabled, use **Command Prompt** instead, or type `npm.cmd` in place of `npm`.

## Step 7: Fill in the settings

```
cd /d C:\IMS\ims-dev
copy .env.example .env
notepad .env
```

Change these lines and save:

```
APP_ENV=development
PORT=8080
DB_NAME=ims_dev
DB_USER=ims_app
DB_PASSWORD=<the password from step 4>
UPLOAD_DIR=C:\IMS\data\dev\uploads
BACKUP_DIR=D:\IMS_Backups\dev
```

`UPLOAD_DIR` holds the scanned invoices and feedback screenshots. `BACKUP_DIR` should be on another drive or a network share. If the server has no `D:` drive yet, use `C:\IMS_Backups\dev` for now and move it later.

## Step 8: Create the tables

For the development copy, with sample data to try everything:

```
npm run init-db:sample
```

It prints `Tables are ready`. On a new database it also loads the sample lab. On an existing database it keeps the data and only puts the sample accounts back with their listed passwords (`npm start` does the same check every time in the development copy).

## Step 9: Try it

```
npm start
```

It prints `Hardware Lab IMS v3.0.0 (development) is running on port 8080`. On the server, open Edge at `http://localhost:8080` and sign in as `sa001@lab.example`, password `Lab@1001`.

Press **Ctrl+C** in the Command Prompt to stop it again.

If a sample sign-in says "Too many wrong tries", wait 10 minutes or stop and start the IMS again.

## Step 10: Open the port for the lab network

Open **PowerShell as Administrator** and run:

```powershell
New-NetFirewallRule -DisplayName "Hardware Lab IMS (dev) 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```

Start the app again (`npm start`) and, from an office laptop, open `http://<server-ip>:8080`. If it does not open, the network between the laptop and the server may block the port; ask IT to allow TCP 8080 to the server.

## Step 11: Keep it running after restarts

Use the built-in **Task Scheduler**, so no extra software is needed:

1. Start menu → **Task Scheduler** → **Create Task...** (not "Basic Task").
2. **General** tab: name `Hardware Lab IMS (dev)`. Select **Run whether user is logged on or not**.
3. **Triggers** tab → **New** → Begin the task: **At startup** → OK.
4. **Actions** tab → **New** → Program: `C:\IMS\ims-dev\scripts\windows\start-ims.cmd` → OK.
5. **Settings** tab:
   - Tick **If the task fails, restart every 1 minute**, attempt to restart up to **999** times.
   - Untick **Stop the task if it runs longer than 3 days**.
6. Select **OK** and enter the Windows account password when asked.
7. Right-click the task → **Run**, then open `http://localhost:8080` to confirm.

The app writes its log to `C:\IMS\ims-dev\logs\ims.log`. To stop it, right-click the task → **End**.

## Step 12: Backups

The app already takes one JSON backup a day into `BACKUP_DIR` (and one whenever the Super Admin selects **Back up now**), and keeps 30 days.

For a full MySQL copy as well:

1. Create `C:\IMS\mysql-backup.cnf` with Notepad:
   ```
   [client]
   user=ims_app
   password=<the password from step 4>
   ```
   Right-click it → **Properties** → **Security**, and leave access only for Administrators and the account that runs the task.
2. In Task Scheduler, create a task named `IMS MySQL backup (dev)` with these settings:
   - **Trigger:** daily at 01:30.
   - **Action:** program `C:\IMS\ims-dev\scripts\windows\mysql-backup.cmd`, arguments `ims_dev D:\IMS_Backups\dev\mysql`.
   - Select **Run whether user is logged on or not**.
3. Right-click → **Run** once and check that a `.sql` file appears.

If SharePoint is used later, sync only the backup folder there. The live MySQL database stays on the server.

### Restoring

- **From a MySQL dump:** MySQL Command Line Client as root → `DROP DATABASE ims_dev; CREATE DATABASE ims_dev CHARACTER SET utf8mb4;` then, in Command Prompt:
  ```
  "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -u root -p ims_dev < D:\IMS_Backups\dev\mysql\ims_dev_<date>.sql
  ```
- **Uploaded documents:** copy `BACKUP_DIR\uploads` back to `UPLOAD_DIR`.

## Step 13: The production copy (later)

Repeat the steps with these differences:

| | Development | Production |
|---|---|---|
| Folder | `C:\IMS\ims-dev` | `C:\IMS\ims-prod` |
| Database (step 4) | `ims_dev` | `ims_prod` (`GRANT ALL ON ims_prod.* TO 'ims_app'@'localhost';`) |
| `.env` | `APP_ENV=development`, `PORT=8080` | `APP_ENV=production`, `PORT=8081` |
| Folders | `...\dev\...` | `...\prod\...` |
| Step 8 | `npm run init-db:sample` | `npm run init-db`, then `npm run create-admin` for the first Super Admin |
| Task names | `(dev)` | `(prod)` |

In production, the sample buttons and **Reset sample data** are switched off. Load the real people with **Accounts → Import many people**: open the team list in Excel, select the rows including the header row (Name, Team, Emp ID, Email Address), copy, and paste into the box. Teams that do not exist yet are created automatically. Without a header row, each line is read as `Emp ID, mail ID, full name, team`. Then, on **Teams**, choose each team's Lead Admin and its members.

There are two ways to give people accounts:

- **First passwords (quickest for a test round):** on **Accounts**, select **Create accounts with first passwords**. Everyone on the directory without an account gets an active User account, and a file `IMS_first_passwords.csv` downloads with each person's mail ID and first password. Send each person only their own row (for example with an Outlook mail merge), never the whole file. At their first sign-in they must choose their own password. The passwords cannot be shown again; if someone loses theirs, select them on **Accounts** → **Give a new first password**.
- **Request access:** each person opens the IMS, selects **Request access**, enters their mail ID and chooses their own password. On **Accounts**, **Approve all waiting as User** approves everyone waiting at once.

Either way, give the Admin and Super Admin roles afterwards by selecting those people one by one on **Accounts**.

## Updating to a new version

1. Task Scheduler → right-click `Hardware Lab IMS (dev)` → **End**.
2. Take a backup (`npm run backup`).
3. Replace the app files with the new version. Keep `.env`, `node_modules` and `logs`.
4. Run `npm install --omit=dev`, then `npm run init-db`. The second command only creates missing tables and adds missing columns; it never deletes data. (The app also adds missing columns by itself when it starts.)
5. Right-click the task → **Run**.

Test a new version on the development copy first, then repeat these steps on production.

On the development copy, select **Accounts → Reset sample data** after an update to see the newest sample lab. Items recorded before version 2.2 have no storage room yet; the first time an Admin edits one, the IMS asks for it.

### Updating from version 2.x to 3.0

Version 3.0 signs in with the **mail ID and password** instead of alias and code. The update keeps every account and item:

- When the app starts, it updates the database by itself and prints `Database brought up to date: ...` once.
- Everyone signs in with their mail ID and their old code until they change it on **My account → Change password**. New passwords must be 8 to 64 characters.
- If the Super Admin's mail ID was never recorded or the code is forgotten, run `npm run create-admin` again with the same Emp ID: it sets the mail ID and a new password.
- Items handed to a person from now on wait for that person to press **Accept**.

The version number (from `package.json`) shows at the bottom of every page, for example `Hardware Lab IMS v3.0.0 · development`. After an update, check it to confirm the new version is running, and ask testers to include it when they report a problem.

## Troubleshooting

| What you see | What to do |
|---|---|
| `Could not start: Access denied for user 'ims_app'` | The password in `.env` does not match step 4. |
| `Could not start: connect ECONNREFUSED 127.0.0.1:3306` | The MySQL service is stopped. Open **Services**, find `MySQL84`, and select **Start**. |
| `Error: listen EADDRINUSE :::8080` | Something else uses port 8080; the IMS may already be running. Choose another `PORT` or stop the other program. |
| `'node' is not recognized` | Close and reopen Command Prompt after installing Node.js, or reinstall Node.js with default options. |
| `npm : running scripts is disabled on this system` | Use Command Prompt, or type `npm.cmd`. |
| `npm install` fails with `ETIMEDOUT`, `ECONNRESET` or a certificate error | The office network blocks or inspects downloads. Use the Releases zip, which already includes the packages. |
| **Back up now** fails | The `BACKUP_DIR` drive or share does not exist or cannot be written. Fix the path in `.env` and restart the app. |
| The page opens on the server but not from a laptop | Check step 10, and ask IT to allow TCP 8080 to the server. |
| "Something went wrong on the server" | Read `logs\ims.log` for the details. |

"use strict";

const express = require("express");
const db = require("../db");
const auth = require("../auth");
const { requireUser, requireRole } = auth;
const {
  ROLES, fail, clean, normalizeId, validEmpId, isMailId, cleanEmail, checkPassword, csvCells
} = require("../rules");

const router = express.Router();
const superAdmin = requireRole("Super Admin");

function accountState(row) {
  if (row.approval === "Pending") return "Pending";
  if (row.approval === "Rejected") return "Rejected";
  return row.active ? "Active" : "Inactive";
}

function personText(name, email) {
  return name ? name + (email ? " (" + email + ")" : "") : email || "";
}

async function teamExists(teamId, conn = db) {
  if (teamId === null) return true;
  return !!(await conn.one("SELECT team_id FROM teams WHERE team_id = ?", [teamId]));
}

function readTeamId(value) {
  if (value === "" || value === null || value === undefined) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) fail("Choose a team.");
  return id;
}

// "QA -APU" and "QA-APU" are the same team.
function cleanTeamName(value) {
  return clean(value, 80).replace(/\s*-\s*/g, "-").replace(/\s+/g, " ");
}

// ---- Sign-in, request access, own account ----

router.post("/login", async (req, res) => {
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password ?? "");
  if (!email || !password) fail("Enter your mail ID and your password.");
  const wait = auth.lockedMinutes(email);
  if (wait) fail("Too many wrong tries. Try again in " + wait + " minute(s).", 429);
  const user = await db.one("SELECT * FROM users WHERE email = ?", [email]);
  if (!user || !auth.codeMatches(password, user.access_hash)) {
    auth.noteFailure(email);
    fail("Mail ID or password is not correct.", 401);
  }
  auth.clearFailures(email);
  if (user.approval === "Pending") fail("Your request is waiting for Super Admin approval.", 403);
  if (user.approval === "Rejected") fail("This request was not approved. Ask a Super Admin.", 403);
  if (!user.active) fail("This account is inactive. Ask a Super Admin to turn it back on.", 403);
  await auth.startSession(res, user.emp_id);
  res.json({ message: "Signed in." });
});

router.post("/logout", async (req, res) => {
  await auth.endSession(req, res);
  res.json({ message: "Signed out." });
});

router.get("/me", requireUser, async (req, res) => {
  const lead = req.user.team_id
    ? await db.one(`SELECT u.emp_name, u.email FROM teams t JOIN users u ON u.emp_id = t.lead_emp_id
                     WHERE t.team_id = ?`, [req.user.team_id])
    : null;
  const ledTeams = await db.query("SELECT team_name FROM teams WHERE lead_emp_id = ? ORDER BY team_name", [req.user.emp_id]);
  res.json({
    empId: req.user.emp_id,
    name: req.user.emp_name,
    email: req.user.email,
    role: req.user.role,
    teamName: req.user.team_name || "",
    lead: lead ? personText(lead.emp_name, lead.email) : "",
    ledTeams: ledTeams.map((t) => t.team_name),
    mustChange: !!req.user.must_change
  });
});

router.post("/register", async (req, res) => {
  const email = cleanEmail(req.body.email);
  const requestedRole = ROLES.includes(req.body.requestedRole) ? req.body.requestedRole : "User";
  const password = String(req.body.password ?? "");
  if (!isMailId(email)) fail("Enter your mail ID in the form name@wipro.com.");
  checkPassword(password, String(req.body.confirm ?? ""));
  const listed = await db.one("SELECT * FROM directory WHERE email = ?", [email]);
  if (!listed) fail("This mail ID is not on the lab directory. Ask a Super Admin to add you first.");
  const existing = await db.one("SELECT approval FROM users WHERE emp_id = ? OR email = ?", [listed.emp_id, email]);
  if (existing) {
    fail(existing.approval === "Rejected"
      ? "This mail ID was not approved. Ask a Super Admin to review it again."
      : "This mail ID already has an account. Sign in, or wait for approval.");
  }
  await db.query(
    `INSERT INTO users (emp_id, emp_name, email, role, requested_role, team_id, approval, active, access_hash)
     VALUES (?, ?, ?, 'User', ?, ?, 'Pending', 0, ?)`,
    [listed.emp_id, listed.emp_name, email, requestedRole, listed.team_id, auth.hashCode(password)]
  );
  res.json({ message: "Request sent for " + email + ". A Super Admin must approve it before you can sign in." });
});

router.post("/me/password", requireUser, async (req, res) => {
  const current = String(req.body.current ?? "");
  const next = String(req.body.next ?? "");
  checkPassword(next, String(req.body.confirm ?? ""));
  if (next === current) fail("Choose a new password that is different from the current one.");
  const row = await db.one("SELECT access_hash FROM users WHERE emp_id = ?", [req.user.emp_id]);
  if (!row || !auth.codeMatches(current, row.access_hash)) fail("The current password is not correct.");
  await db.query("UPDATE users SET access_hash = ?, must_change = 0 WHERE emp_id = ?", [auth.hashCode(next), req.user.emp_id]);
  res.json({ message: "Your password was changed. Use the new password next time you sign in." });
});

// Active people, for the "give to" mail ID lists.
router.get("/people", requireRole("Super Admin", "Admin"), async (req, res) => {
  const rows = await db.query(
    `SELECT u.emp_id, u.emp_name, u.email, t.team_name FROM users u LEFT JOIN teams t ON t.team_id = u.team_id
      WHERE u.active = 1 AND u.approval = 'Approved' ORDER BY u.emp_name`);
  res.json(rows.map((u) => ({ empId: u.emp_id, name: u.emp_name, email: u.email, teamName: u.team_name || "" })));
});

// ---- Teams (everyone can read names; Super Admin edits) ----

router.get("/teams", requireUser, async (req, res) => {
  const rows = await db.query(
    `SELECT t.team_id, t.team_name, t.lead_emp_id, l.emp_name AS lead_name, l.email AS lead_email,
            (SELECT COUNT(*) FROM directory d WHERE d.team_id = t.team_id) AS members
       FROM teams t LEFT JOIN users l ON l.emp_id = t.lead_emp_id ORDER BY t.team_name`);
  res.json(rows.map((t) => ({
    id: t.team_id, name: t.team_name, leadId: t.lead_emp_id || "", lead: personText(t.lead_name, t.lead_email),
    members: Number(t.members)
  })));
});

async function readTeam(body) {
  const name = cleanTeamName(body.name);
  const leadId = normalizeId(body.leadId);
  if (name.length < 2) fail("Enter the team name.");
  if (leadId) {
    const lead = await db.one("SELECT emp_name, role, active FROM users WHERE emp_id = ?", [leadId]);
    if (!lead || !lead.active || lead.role === "User") {
      fail((lead ? lead.emp_name : leadId) + " is not an active Lead Admin, Admin or Super Admin.");
    }
  }
  return { name, leadId };
}

router.post("/teams", superAdmin, async (req, res) => {
  const team = await readTeam(req.body);
  if (await db.one("SELECT team_id FROM teams WHERE team_name = ?", [team.name])) fail("A team with this name already exists.");
  const result = await db.query("INSERT INTO teams (team_name, lead_emp_id) VALUES (?, ?)", [team.name, team.leadId || null]);
  res.json({ message: "Team " + team.name + " added.", id: result.insertId, name: team.name });
});

router.put("/teams/:id", superAdmin, async (req, res) => {
  const id = readTeamId(req.params.id);
  const team = await readTeam(req.body);
  if (!(await teamExists(id))) fail("Team not found.", 404);
  if (await db.one("SELECT team_id FROM teams WHERE team_name = ? AND team_id <> ?", [team.name, id])) {
    fail("A team with this name already exists.");
  }
  await db.query("UPDATE teams SET team_name = ?, lead_emp_id = ? WHERE team_id = ?", [team.name, team.leadId || null, id]);
  res.json({ message: "Team " + team.name + " saved." });
});

// Puts people from the lab directory into a team, or takes them out of it.
router.post("/teams/:id/members", superAdmin, async (req, res) => {
  const id = readTeamId(req.params.id);
  if (!(await teamExists(id))) fail("Team not found.", 404);
  const add = (Array.isArray(req.body.add) ? req.body.add : []).map(normalizeId).filter(Boolean);
  const remove = (Array.isArray(req.body.remove) ? req.body.remove : []).map(normalizeId).filter(Boolean);
  if (!add.length && !remove.length) fail("Choose at least one person.");
  await db.transaction(async (conn) => {
    for (const empId of add) {
      await conn.query("UPDATE directory SET team_id = ? WHERE emp_id = ?", [id, empId]);
      await conn.query("UPDATE users SET team_id = ? WHERE emp_id = ?", [id, empId]);
    }
    for (const empId of remove) {
      await conn.query("UPDATE directory SET team_id = NULL WHERE emp_id = ? AND team_id = ?", [empId, id]);
      await conn.query("UPDATE users SET team_id = NULL WHERE emp_id = ? AND team_id = ?", [empId, id]);
    }
  });
  const parts = [];
  if (add.length) parts.push(add.length + " added");
  if (remove.length) parts.push(remove.length + " removed");
  res.json({ message: "Team members saved: " + parts.join(", ") + "." });
});

// Makes a directory person a Lead Admin. Someone without an account gets one with a first password.
router.post("/users/make-lead", superAdmin, async (req, res) => {
  const empId = normalizeId(req.body.empId);
  const password = String(req.body.password ?? "");
  const listed = await db.one("SELECT * FROM directory WHERE emp_id = ?", [empId]);
  const user = await db.one("SELECT * FROM users WHERE emp_id = ?", [empId]);
  if (!listed && !user) fail("Choose a person from the lab directory.");
  if (user) {
    const role = user.role === "User" ? "Lead Admin" : user.role;
    await db.query("UPDATE users SET role = ?, approval = 'Approved', active = 1 WHERE emp_id = ?", [role, empId]);
    return res.json({ message: user.emp_name + " is now an active " + role + ".", empId });
  }
  if (!password) fail(listed.emp_name + " has no account yet. Set a first password for them.");
  checkPassword(password);
  await db.query(
    `INSERT INTO users (emp_id, emp_name, email, role, requested_role, team_id, approval, active, access_hash, must_change)
     VALUES (?, ?, ?, 'Lead Admin', 'Lead Admin', ?, 'Approved', 1, ?, 1)`,
    [empId, listed.emp_name, listed.email, listed.team_id, auth.hashCode(password)]
  );
  res.json({
    message: listed.emp_name + " is now a Lead Admin. Give them the first password and ask them to change it in My account.",
    empId
  });
});

// ---- Accounts (Super Admin) ----

router.get("/users", superAdmin, async (req, res) => {
  const rows = await db.query(
    `SELECT u.*, t.team_name FROM users u LEFT JOIN teams t ON t.team_id = u.team_id
      ORDER BY (u.approval = 'Pending') DESC, u.role, u.emp_name`);
  res.json(rows.map((u) => ({
    empId: u.emp_id, name: u.emp_name, email: u.email, role: u.role, requestedRole: u.requested_role,
    teamId: u.team_id, teamName: u.team_name || "", state: accountState(u), createdAt: u.created_at
  })));
});

router.put("/users/:id", superAdmin, async (req, res) => {
  const empId = normalizeId(req.params.id);
  const role = clean(req.body.role);
  const active = req.body.active === true;
  const teamId = readTeamId(req.body.teamId);
  if (!ROLES.includes(role)) fail("Choose a role.");
  if (!(await teamExists(teamId))) fail("Choose a team.");
  const name = await db.transaction(async (conn) => {
    const target = await conn.one("SELECT * FROM users WHERE emp_id = ? FOR UPDATE", [empId]);
    if (!target) fail("Account not found.", 404);
    if (target.emp_id === req.user.emp_id && (!active || role !== "Super Admin")) {
      fail("You cannot turn off your own account or remove your own Super Admin role.");
    }
    if (target.role === "Super Admin" && target.active && (role !== "Super Admin" || !active)) {
      const others = await conn.one(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'Super Admin' AND active = 1 AND emp_id <> ?", [empId]);
      if (!Number(others.n)) fail("Keep at least one active Super Admin.");
    }
    if (role === "User") {
      await conn.query("UPDATE teams SET lead_emp_id = NULL WHERE lead_emp_id = ?", [empId]);
    }
    await conn.query(
      `UPDATE users SET role = ?, team_id = ?, active = ?, approval = IF(? = 1, 'Approved', approval) WHERE emp_id = ?`,
      [role, teamId, active ? 1 : 0, active ? 1 : 0, empId]
    );
    await conn.query("UPDATE directory SET team_id = ? WHERE emp_id = ?", [teamId, empId]);
    return target.emp_name;
  });
  if (!active) await auth.endAllSessions(empId);
  res.json({ message: "Saved " + name + "." });
});

// Gives everyone on the directory without an account an active User account with its own first
// password. The passwords are returned once, for the Super Admin to hand out; only hashes are kept.
router.post("/users/create-all", superAdmin, async (req, res) => {
  const people = await db.query(
    `SELECT d.emp_id, d.emp_name, d.email, d.team_id, t.team_name FROM directory d
       LEFT JOIN teams t ON t.team_id = d.team_id
      WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.emp_id = d.emp_id OR u.email = d.email)
      ORDER BY t.team_name, d.emp_name`);
  const accounts = [];
  await db.transaction(async (conn) => {
    for (const p of people) {
      const password = auth.firstPassword();
      await conn.query(
        `INSERT INTO users (emp_id, emp_name, email, role, requested_role, team_id, approval, active, access_hash, must_change)
         VALUES (?, ?, ?, 'User', 'User', ?, 'Approved', 1, ?, 1)`,
        [p.emp_id, p.emp_name, p.email, p.team_id, auth.hashCode(password)]);
      accounts.push({ name: p.emp_name, team: p.team_name || "", empId: p.emp_id, email: p.email, password });
    }
  });
  res.json({
    message: accounts.length
      ? "Created " + accounts.length + " account(s). Save the downloaded file now: the passwords cannot be shown again."
      : "Everyone on the lab directory already has an account.",
    accounts
  });
});

router.post("/users/:id/new-password", superAdmin, async (req, res) => {
  const empId = normalizeId(req.params.id);
  if (empId === req.user.emp_id) fail("Change your own password in My account.");
  const target = await db.one("SELECT emp_name, email FROM users WHERE emp_id = ?", [empId]);
  if (!target) fail("Account not found.", 404);
  const password = auth.firstPassword();
  await db.query("UPDATE users SET access_hash = ?, must_change = 1 WHERE emp_id = ?", [auth.hashCode(password), empId]);
  await auth.endAllSessions(empId);
  res.json({
    message: "New first password for " + target.emp_name + " (" + target.email + "): " + password
      + ". Give it only to them; they choose their own password when they sign in.",
    password
  });
});

// Every waiting request becomes an active User; Admin and Lead roles are still given one by one.
router.post("/users/approve-all", superAdmin, async (req, res) => {
  const result = await db.query(
    "UPDATE users SET approval = 'Approved', active = 1, role = 'User' WHERE approval = 'Pending'");
  const count = result.affectedRows;
  res.json({ message: count ? "Approved " + count + " waiting request(s) as User." : "No requests are waiting." });
});

router.post("/users/:id/reject", superAdmin, async (req, res) => {
  const empId = normalizeId(req.params.id);
  if (empId === req.user.emp_id) fail("You cannot reject your own account.");
  const target = await db.one("SELECT emp_name, approval FROM users WHERE emp_id = ?", [empId]);
  if (!target) fail("Account not found.", 404);
  if (target.approval !== "Pending") fail("Only waiting requests can be rejected. Turn the account off instead.");
  await db.query("UPDATE users SET approval = 'Rejected', active = 0 WHERE emp_id = ?", [empId]);
  res.json({ message: "Rejected " + target.emp_name + "." });
});

// ---- Lab directory (Super Admin) ----

router.get("/directory", superAdmin, async (req, res) => {
  const rows = await db.query(
    `SELECT d.*, t.team_name, u.role, (u.emp_id IS NOT NULL) AS has_account
       FROM directory d LEFT JOIN teams t ON t.team_id = d.team_id LEFT JOIN users u ON u.emp_id = d.emp_id
      ORDER BY d.emp_name`);
  res.json(rows.map((d) => ({
    empId: d.emp_id, email: d.email, name: d.emp_name, teamId: d.team_id, teamName: d.team_name || "",
    hasAccount: !!Number(d.has_account), role: d.role || ""
  })));
});

async function upsertDirectory(entry, actor) {
  const empId = normalizeId(entry.empId);
  const email = cleanEmail(entry.email);
  const name = clean(entry.name, 120).replace(/\s+/g, " ");
  if (!validEmpId(empId)) fail("Emp ID must be 2 to 32 letters, digits or hyphens (" + (entry.empId || "blank") + ").");
  if (!isMailId(email)) fail("Mail ID is not valid for " + (name || empId) + ".");
  if (!name) fail("Enter the full name for " + email + ".");
  const clash = await db.one("SELECT emp_id, emp_name FROM directory WHERE email = ? AND emp_id <> ?", [email, empId]);
  if (clash) fail("Mail ID " + email + " is already used by " + clash.emp_name + ".");
  await db.query(
    `INSERT INTO directory (emp_id, email, emp_name, team_id, added_by) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE email = VALUES(email), emp_name = VALUES(emp_name), team_id = VALUES(team_id)`,
    [empId, email, name, entry.teamId, actor]
  );
  await db.query("UPDATE users SET email = ?, emp_name = ?, team_id = ? WHERE emp_id = ?", [email, name, entry.teamId, empId]);
  return name;
}

router.post("/directory", superAdmin, async (req, res) => {
  const teamId = readTeamId(req.body.teamId);
  if (!(await teamExists(teamId))) fail("Choose a team.");
  const name = await upsertDirectory({ ...req.body, teamId }, req.user.emp_id);
  res.json({ message: "Directory updated for " + name + "." });
});

// Columns found from a header line, for example rows copied from Excel with their headings.
function importColumns(cells) {
  const find = (test) => cells.findIndex((cell) => test(cell.toLowerCase()));
  const columns = {
    email: find((c) => c.includes("mail")),
    empId: find((c) => /emp|employee|^id$/.test(c) && !c.includes("mail")),
    name: find((c) => c.includes("name") && !c.includes("team")),
    team: find((c) => c.includes("team"))
  };
  return columns.email >= 0 && columns.name >= 0 && columns.empId >= 0 ? columns : null;
}

// Lines of: Emp ID, mail ID, full name, team (team optional). A header line may set another order.
// Teams that do not exist yet are created.
router.post("/directory/import", superAdmin, async (req, res) => {
  const lines = String(req.body.text || "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) fail("Paste at least one line: Emp ID, mail ID, full name, team.");
  if (lines.length > 1000) fail("Import at most 1000 lines at a time.");
  let columns = { empId: 0, email: 1, name: 2, team: 3 };
  const header = importColumns(csvCells(lines[0]));
  if (header) columns = header;
  const teams = await db.query("SELECT team_id, team_name FROM teams");
  const byName = new Map(teams.map((t) => [t.team_name.toLowerCase(), t.team_id]));
  const newTeams = [];
  const problems = [];
  let saved = 0;
  for (const [index, line] of lines.entries()) {
    if (index === 0 && header) continue;
    const cells = csvCells(line);
    const cell = (key) => (columns[key] >= 0 ? cells[columns[key]] || "" : "");
    if (!cell("email") && !cell("empId")) continue;
    try {
      let teamId = null;
      const teamName = cleanTeamName(cell("team"));
      if (teamName) {
        teamId = byName.get(teamName.toLowerCase()) || null;
        if (!teamId) {
          teamId = (await db.query("INSERT INTO teams (team_name) VALUES (?)", [teamName])).insertId;
          byName.set(teamName.toLowerCase(), teamId);
          newTeams.push(teamName);
        }
      }
      await upsertDirectory({ empId: cell("empId"), email: cell("email"), name: cell("name"), teamId }, req.user.emp_id);
      saved += 1;
    } catch (error) {
      if (!error.status) throw error;
      problems.push("Line " + (index + 1) + ": " + error.message);
    }
  }
  res.json({
    message: saved + " people saved." + (newTeams.length ? " New teams: " + newTeams.join(", ") + "." : "")
      + (problems.length ? " " + problems.length + " lines skipped." : ""),
    problems
  });
});

module.exports = { router, personText };

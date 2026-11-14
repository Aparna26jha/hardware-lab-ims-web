"use strict";

const express = require("express");
const db = require("../db");
const auth = require("../auth");
const { requireUser, requireRole } = auth;
const { ROLES, fail, clean, normalizeId, validAlias, isMailId, checkAccessCode, csvCells } = require("../rules");

const router = express.Router();
const superAdmin = requireRole("Super Admin");

function accountState(row) {
  if (row.approval === "Pending") return "Pending";
  if (row.approval === "Rejected") return "Rejected";
  return row.active ? "Active" : "Inactive";
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

// ---- Sign-in, request access, own account ----

router.post("/login", async (req, res) => {
  const login = clean(req.body.login, 120);
  const code = String(req.body.code ?? "");
  const key = login.toLowerCase();
  if (!login || !code) fail("Enter your alias ID or mail ID, and your access code.");
  const wait = auth.lockedMinutes(key);
  if (wait) fail("Too many wrong tries. Try again in " + wait + " minute(s).", 429);
  const user = await db.one("SELECT * FROM users WHERE emp_id = ? OR email = ?", [normalizeId(login), login.toLowerCase()]);
  if (!user || !auth.codeMatches(code, user.access_hash)) {
    auth.noteFailure(key);
    fail("Alias ID, mail ID or access code is not recognized.", 401);
  }
  auth.clearFailures(key);
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
    ? await db.one(`SELECT u.emp_id, u.emp_name FROM teams t JOIN users u ON u.emp_id = t.lead_emp_id
                     WHERE t.team_id = ?`, [req.user.team_id])
    : null;
  const ledTeams = await db.query("SELECT team_name FROM teams WHERE lead_emp_id = ? ORDER BY team_name", [req.user.emp_id]);
  res.json({
    empId: req.user.emp_id,
    name: req.user.emp_name,
    email: req.user.email,
    role: req.user.role,
    teamName: req.user.team_name || "",
    lead: lead ? lead.emp_id + " " + lead.emp_name : "",
    ledTeams: ledTeams.map((t) => t.team_name)
  });
});

router.post("/register", async (req, res) => {
  const alias = normalizeId(req.body.alias);
  const name = clean(req.body.name, 120);
  const email = clean(req.body.email, 120).toLowerCase();
  const requestedRole = ROLES.includes(req.body.requestedRole) ? req.body.requestedRole : "User";
  const code = String(req.body.code ?? "");
  if (!validAlias(alias)) fail("Alias ID must be 2 to 32 letters, digits or hyphens.");
  if (!name) fail("Enter your full name.");
  if (!isMailId(email)) fail("Enter the mail ID in the form name@company.com.");
  checkAccessCode(code, String(req.body.confirm ?? ""));
  const listed = await db.one("SELECT * FROM directory WHERE alias = ?", [alias]);
  if (!listed) fail("That alias is not on the lab directory. Ask a Super Admin to add you first.");
  if (listed.email.toLowerCase() !== email) fail("The mail ID does not match the lab directory for this alias.");
  if (listed.emp_name.toLowerCase() !== name.toLowerCase()) fail("The full name does not match the lab directory for this alias.");
  const existing = await db.one("SELECT approval FROM users WHERE emp_id = ? OR email = ?", [alias, email]);
  if (existing) {
    fail(existing.approval === "Rejected"
      ? "This alias was not approved. Ask a Super Admin to review it again."
      : "This alias already has an account. Sign in, or wait for approval.");
  }
  await db.query(
    `INSERT INTO users (emp_id, emp_name, email, role, requested_role, team_id, approval, active, access_hash)
     VALUES (?, ?, ?, 'User', ?, ?, 'Pending', 0, ?)`,
    [alias, listed.emp_name, listed.email.toLowerCase(), requestedRole, listed.team_id, auth.hashCode(code)]
  );
  res.json({ message: "Request sent for " + alias + ". A Super Admin must approve it before you can sign in." });
});

router.post("/me/code", requireUser, async (req, res) => {
  const current = String(req.body.current ?? "");
  const next = String(req.body.next ?? "");
  checkAccessCode(next, String(req.body.confirm ?? ""));
  if (next === current) fail("Choose a new code that is different from the current one.");
  const row = await db.one("SELECT access_hash FROM users WHERE emp_id = ?", [req.user.emp_id]);
  if (!row || !auth.codeMatches(current, row.access_hash)) fail("The current access code is not correct.");
  await db.query("UPDATE users SET access_hash = ? WHERE emp_id = ?", [auth.hashCode(next), req.user.emp_id]);
  res.json({ message: "Your access code was changed. Use the new code next time you sign in." });
});

// ---- Teams (everyone can read names; Super Admin edits) ----

router.get("/teams", requireUser, async (req, res) => {
  const rows = await db.query(
    `SELECT t.team_id, t.team_name, t.lead_emp_id, l.emp_name AS lead_name,
            (SELECT COUNT(*) FROM users m WHERE m.team_id = t.team_id AND m.active = 1) AS members
       FROM teams t LEFT JOIN users l ON l.emp_id = t.lead_emp_id ORDER BY t.team_name`);
  res.json(rows.map((t) => ({
    id: t.team_id, name: t.team_name, leadId: t.lead_emp_id || "", leadName: t.lead_name || "", members: Number(t.members)
  })));
});

async function readTeam(body) {
  const name = clean(body.name, 80);
  const leadId = normalizeId(body.leadId);
  if (name.length < 2) fail("Enter the team name.");
  if (leadId) {
    const lead = await db.one("SELECT role, active FROM users WHERE emp_id = ?", [leadId]);
    if (!lead || !lead.active || lead.role === "User") fail(leadId + " is not an active Lead Admin, Admin or Super Admin.");
  }
  return { name, leadId };
}

router.post("/teams", superAdmin, async (req, res) => {
  const team = await readTeam(req.body);
  if (await db.one("SELECT team_id FROM teams WHERE team_name = ?", [team.name])) fail("A team with this name already exists.");
  await db.query("INSERT INTO teams (team_name, lead_emp_id) VALUES (?, ?)", [team.name, team.leadId || null]);
  res.json({ message: "Team " + team.name + " added." });
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

// ---- Accounts (Super Admin) ----

router.get("/users", superAdmin, async (req, res) => {
  const rows = await db.query(
    `SELECT u.*, t.team_name FROM users u LEFT JOIN teams t ON t.team_id = u.team_id
      ORDER BY (u.approval = 'Pending') DESC, u.role, u.emp_id`);
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
  await db.transaction(async (conn) => {
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
  });
  if (!active) await auth.endAllSessions(empId);
  res.json({ message: "Saved " + empId + "." });
});

router.post("/users/:id/reject", superAdmin, async (req, res) => {
  const empId = normalizeId(req.params.id);
  if (empId === req.user.emp_id) fail("You cannot reject your own account.");
  const target = await db.one("SELECT approval FROM users WHERE emp_id = ?", [empId]);
  if (!target) fail("Account not found.", 404);
  if (target.approval !== "Pending") fail("Only waiting requests can be rejected. Turn the account off instead.");
  await db.query("UPDATE users SET approval = 'Rejected', active = 0 WHERE emp_id = ?", [empId]);
  res.json({ message: "Rejected " + empId + "." });
});

// ---- Lab directory (Super Admin) ----

router.get("/directory", superAdmin, async (req, res) => {
  const rows = await db.query(
    `SELECT d.*, t.team_name, (u.emp_id IS NOT NULL) AS has_account
       FROM directory d LEFT JOIN teams t ON t.team_id = d.team_id LEFT JOIN users u ON u.emp_id = d.alias
      ORDER BY d.alias`);
  res.json(rows.map((d) => ({
    alias: d.alias, email: d.email, name: d.emp_name, teamId: d.team_id, teamName: d.team_name || "",
    hasAccount: !!Number(d.has_account)
  })));
});

async function upsertDirectory(entry, actor) {
  const alias = normalizeId(entry.alias);
  const email = clean(entry.email, 120).toLowerCase();
  const name = clean(entry.name, 120);
  if (!validAlias(alias)) fail("Alias ID must be 2 to 32 letters, digits or hyphens (" + (entry.alias || "blank") + ").");
  if (!isMailId(email)) fail("Mail ID is not valid for " + alias + ".");
  if (!name) fail("Enter the full name for " + alias + ".");
  const clash = await db.one("SELECT alias FROM directory WHERE email = ? AND alias <> ?", [email, alias]);
  if (clash) fail("Mail ID " + email + " is already used by " + clash.alias + ".");
  await db.query(
    `INSERT INTO directory (alias, email, emp_name, team_id, added_by) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE email = VALUES(email), emp_name = VALUES(emp_name), team_id = VALUES(team_id)`,
    [alias, email, name, entry.teamId, actor]
  );
  return alias;
}

router.post("/directory", superAdmin, async (req, res) => {
  const teamId = readTeamId(req.body.teamId);
  if (!(await teamExists(teamId))) fail("Choose a team.");
  const alias = await upsertDirectory({ ...req.body, teamId }, req.user.emp_id);
  res.json({ message: "Directory updated for " + alias + "." });
});

// Lines of: alias, mail ID, full name, team name (team optional)
router.post("/directory/import", superAdmin, async (req, res) => {
  const lines = String(req.body.text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) fail("Paste at least one line: alias, mail ID, full name, team.");
  if (lines.length > 500) fail("Import at most 500 lines at a time.");
  const teams = await db.query("SELECT team_id, team_name FROM teams");
  const byName = new Map(teams.map((t) => [t.team_name.toLowerCase(), t.team_id]));
  const problems = [];
  let saved = 0;
  for (const [index, line] of lines.entries()) {
    const [alias, email, name, teamName] = csvCells(line);
    if (index === 0 && /alias/i.test(alias || "")) continue;
    try {
      let teamId = null;
      if (teamName) {
        teamId = byName.get(teamName.toLowerCase()) || null;
        if (!teamId) fail("Team " + teamName + " does not exist yet (" + alias + ").");
      }
      await upsertDirectory({ alias, email, name, teamId }, req.user.emp_id);
      saved += 1;
    } catch (error) {
      if (!error.status) throw error;
      problems.push("Line " + (index + 1) + ": " + error.message);
    }
  }
  res.json({ message: saved + " people saved." + (problems.length ? " " + problems.length + " lines skipped." : ""), problems });
});

module.exports = { router };

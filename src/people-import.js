"use strict";

// Loads people from CSV text and gives everyone without an account an active account with one common
// first password, which each person must change at their first sign-in.
// Columns (any order, header line needed): Name, Team, Emp ID, Email Address, Role, Team Lead.
// Role is Super Admin, Admin, Lead Admin or User (blank = User). Team Lead = Yes makes that person
// the lead shown for the team. Safe to run again: existing accounts keep their password, and only
// their name, team and role are updated (the person importing keeps their own role).
const db = require("./db");
const { hashCode } = require("./auth");
const { ROLES, fail, normalizeId, validEmpId, isMailId, cleanEmail, checkPassword, csvCells } = require("./rules");

function columnsOf(header) {
  const cells = header.map((c) => c.trim().toLowerCase());
  const find = (test) => cells.findIndex(test);
  return {
    name: find((c) => c.includes("name") && !c.includes("team")),
    team: find((c) => c === "team" || c === "team name"),
    empId: find((c) => /emp|employee/.test(c) && !c.includes("mail")),
    email: find((c) => c.includes("mail")),
    role: find((c) => c === "role" || c === "ims role"),
    lead: find((c) => c === "team lead")
  };
}

async function importPeople(text, password, actorEmpId = "") {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 1001) fail("Import at most 1000 people at a time.");
  const col = columnsOf(csvCells(lines[0] || ""));
  if (col.name < 0 || col.empId < 0 || col.email < 0) {
    fail("The first line of the file must be the headings, with at least Name, Emp ID and Email Address.");
  }
  checkPassword(password);
  const hash = hashCode(password);

  const teamIds = new Map((await db.query("SELECT team_id, team_name FROM teams")).map((t) => [t.team_name.toLowerCase(), t.team_id]));
  const result = { created: 0, updated: 0, problems: [] };
  for (const [index, line] of lines.entries()) {
    if (index === 0) continue;
    const cells = csvCells(line);
    const cell = (key) => (col[key] >= 0 ? String(cells[col[key]] || "").trim() : "");
    const name = cell("name").replace(/\s+/g, " ");
    const empId = normalizeId(cell("empId"));
    const email = cleanEmail(cell("email"));
    const role = ROLES.find((r) => r.toLowerCase() === cell("role").toLowerCase()) || "User";
    const where = "Line " + (index + 1) + " (" + (name || email || "blank") + "): ";
    if (!empId) { result.problems.push(where + "no Emp ID."); continue; }
    if (!validEmpId(empId)) { result.problems.push(where + "Emp ID " + empId + " is not valid."); continue; }
    if (!isMailId(email)) { result.problems.push(where + "mail ID is not valid."); continue; }
    if (!name) { result.problems.push(where + "no name."); continue; }
    const clash = await db.one(
      "SELECT emp_name FROM users WHERE email = ? AND emp_id <> ? UNION SELECT emp_name FROM directory WHERE email = ? AND emp_id <> ?",
      [email, empId, email, empId]);
    if (clash) { result.problems.push(where + email + " already belongs to " + clash.emp_name + "."); continue; }

    let teamId = null;
    const teamName = cell("team");
    if (teamName) {
      teamId = teamIds.get(teamName.toLowerCase());
      if (!teamId) {
        teamId = (await db.query("INSERT INTO teams (team_name) VALUES (?)", [teamName])).insertId;
        teamIds.set(teamName.toLowerCase(), teamId);
      }
    }
    await db.query(
      `INSERT INTO directory (emp_id, email, emp_name, team_id, added_by) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE email = VALUES(email), emp_name = VALUES(emp_name), team_id = VALUES(team_id)`,
      [empId, email, name, teamId, actorEmpId || "import"]);
    const existing = await db.one("SELECT emp_id FROM users WHERE emp_id = ?", [empId]);
    if (existing) {
      await db.query("UPDATE users SET emp_name = ?, email = ?, team_id = ?, role = IF(emp_id = ?, role, ?) WHERE emp_id = ?",
        [name, email, teamId, actorEmpId, role, empId]);
      result.updated += 1;
    } else {
      await db.query(
        `INSERT INTO users (emp_id, emp_name, email, role, requested_role, team_id, approval, active, access_hash, must_change)
         VALUES (?, ?, ?, ?, ?, ?, 'Approved', 1, ?, 1)`,
        [empId, name, email, role, role, teamId, hash]);
      result.created += 1;
    }
    if (teamId && /^y/i.test(cell("lead"))) {
      await db.query("UPDATE teams SET lead_emp_id = ? WHERE team_id = ?", [empId, teamId]);
    }
  }
  return result;
}

module.exports = { importPeople };

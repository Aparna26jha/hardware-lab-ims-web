"use strict";

// Loads the real people from a CSV file and gives everyone without an account an active account with
// one common first password, which each person must change at their first sign-in.
//   npm run import-people -- people.csv
// Columns (any order, header line needed): Name, Team, Emp ID, Email Address, Role, Team Lead.
// Role is Super Admin, Admin, Lead Admin or User (blank = User). Team Lead = Yes makes that person
// the lead shown for the team. Safe to run again: existing accounts keep their password, and only
// their name, team and role are updated from the file.
const fs = require("node:fs");
const readline = require("node:readline/promises");
const db = require("../src/db");
const { hashCode } = require("../src/auth");
const { ROLES, normalizeId, validEmpId, isMailId, cleanEmail, checkPassword, csvCells } = require("../src/rules");

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

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Give the file name, for example:  npm run import-people -- people.csv");
  const lines = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  const col = columnsOf(csvCells(lines[0] || ""));
  if (col.name < 0 || col.empId < 0 || col.email < 0) {
    throw new Error("The first line must be the headings, with at least Name, Emp ID and Email Address.");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const password = (await rl.question("Common first password for the new accounts (at least 8 characters): ")).trim();
  rl.close();
  checkPassword(password);
  const hash = hashCode(password);

  const teamIds = new Map((await db.query("SELECT team_id, team_name FROM teams")).map((t) => [t.team_name.toLowerCase(), t.team_id]));
  const counts = { created: 0, updated: 0 };
  const problems = [];
  for (const [index, line] of lines.entries()) {
    if (index === 0) continue;
    const cells = csvCells(line);
    const cell = (key) => (col[key] >= 0 ? String(cells[col[key]] || "").trim() : "");
    const name = cell("name").replace(/\s+/g, " ");
    const empId = normalizeId(cell("empId"));
    const email = cleanEmail(cell("email"));
    const role = ROLES.find((r) => r.toLowerCase() === cell("role").toLowerCase()) || "User";
    const where = "Line " + (index + 1) + " (" + (name || email || "blank") + "): ";
    if (!empId) { problems.push(where + "no Emp ID, skipped."); continue; }
    if (!validEmpId(empId)) { problems.push(where + "Emp ID " + empId + " is not valid, skipped."); continue; }
    if (!isMailId(email)) { problems.push(where + "mail ID is not valid, skipped."); continue; }
    if (!name) { problems.push(where + "no name, skipped."); continue; }
    const clash = await db.one(
      "SELECT emp_name FROM users WHERE email = ? AND emp_id <> ? UNION SELECT emp_name FROM directory WHERE email = ? AND emp_id <> ?",
      [email, empId, email, empId]);
    if (clash) { problems.push(where + email + " already belongs to " + clash.emp_name + ", skipped."); continue; }

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
      `INSERT INTO directory (emp_id, email, emp_name, team_id, added_by) VALUES (?, ?, ?, ?, 'import')
       ON DUPLICATE KEY UPDATE email = VALUES(email), emp_name = VALUES(emp_name), team_id = VALUES(team_id)`,
      [empId, email, name, teamId]);
    const existing = await db.one("SELECT emp_id FROM users WHERE emp_id = ?", [empId]);
    if (existing) {
      await db.query("UPDATE users SET emp_name = ?, email = ?, team_id = ?, role = ? WHERE emp_id = ?",
        [name, email, teamId, role, empId]);
      counts.updated += 1;
    } else {
      await db.query(
        `INSERT INTO users (emp_id, emp_name, email, role, requested_role, team_id, approval, active, access_hash, must_change)
         VALUES (?, ?, ?, ?, ?, ?, 'Approved', 1, ?, 1)`,
        [empId, name, email, role, role, teamId, hash]);
      counts.created += 1;
    }
    if (teamId && /^y/i.test(cell("lead"))) {
      await db.query("UPDATE teams SET lead_emp_id = ? WHERE team_id = ?", [empId, teamId]);
    }
  }
  console.log("Accounts created: " + counts.created + ". Existing accounts updated (password kept): " + counts.updated + ".");
  if (problems.length) console.log("Not imported:\n  " + problems.join("\n  "));
  console.log("Everyone new signs in with their mail ID and the common first password, and must then choose their own.");
}

main()
  .catch((error) => {
    console.error("Could not import: " + error.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());

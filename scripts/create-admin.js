"use strict";

// Adds the first Super Admin (or turns an existing account into an active Super Admin).
// Running it again with the same mail ID also sets a new password, for example when it is forgotten.
const readline = require("node:readline/promises");
const db = require("../src/db");
const { hashCode } = require("../src/auth");
const { normalizeId, validEmpId, isMailId, cleanEmail, checkPassword } = require("../src/rules");

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const empId = normalizeId(await rl.question("Emp ID: "));
  const name = (await rl.question("Full name: ")).trim();
  const email = cleanEmail(await rl.question("Mail ID: "));
  const password = (await rl.question("Password (at least 8 characters): ")).trim();
  rl.close();
  if (!validEmpId(empId)) throw new Error("Emp ID must be 2 to 32 letters, digits or hyphens.");
  if (!name) throw new Error("Enter the full name.");
  if (!isMailId(email)) throw new Error("Enter a valid mail ID.");
  checkPassword(password);
  const clash = await db.one("SELECT emp_name FROM users WHERE email = ? AND emp_id <> ?", [email, empId]);
  if (clash) throw new Error("This mail ID already belongs to " + clash.emp_name + ".");
  await db.query(
    `INSERT INTO users (emp_id, emp_name, email, role, requested_role, approval, active, access_hash)
     VALUES (?, ?, ?, 'Super Admin', 'Super Admin', 'Approved', 1, ?)
     ON DUPLICATE KEY UPDATE emp_name = VALUES(emp_name), email = VALUES(email), role = 'Super Admin',
       approval = 'Approved', active = 1, access_hash = VALUES(access_hash)`,
    [empId, name, email, hashCode(password)]
  );
  await db.query(
    `INSERT INTO directory (emp_id, email, emp_name, added_by) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE email = VALUES(email), emp_name = VALUES(emp_name)`,
    [empId, email, name, empId]
  );
  console.log(name + " (" + email + ") is now an active Super Admin. Sign in at the IMS web address.");
}

main()
  .catch((error) => {
    console.error("Could not add the Super Admin: " + error.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());

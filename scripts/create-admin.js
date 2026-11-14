"use strict";

// Adds the first Super Admin (or turns an existing account into an active Super Admin).
const readline = require("node:readline/promises");
const db = require("../src/db");
const { hashCode } = require("../src/auth");
const { normalizeId, validAlias, isMailId, checkAccessCode } = require("../src/rules");

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const alias = normalizeId(await rl.question("Alias ID: "));
  const name = (await rl.question("Full name: ")).trim();
  const email = (await rl.question("Company mail ID: ")).trim().toLowerCase();
  const code = (await rl.question("Access code (4 to 32 characters): ")).trim();
  rl.close();
  if (!validAlias(alias)) throw new Error("Alias ID must be 2 to 32 letters, digits or hyphens.");
  if (!name) throw new Error("Enter the full name.");
  if (!isMailId(email)) throw new Error("Enter a valid mail ID.");
  checkAccessCode(code);
  const clash = await db.one("SELECT emp_id FROM users WHERE email = ? AND emp_id <> ?", [email, alias]);
  if (clash) throw new Error("This mail ID already belongs to " + clash.emp_id + ".");
  await db.query(
    `INSERT INTO users (emp_id, emp_name, email, role, requested_role, approval, active, access_hash)
     VALUES (?, ?, ?, 'Super Admin', 'Super Admin', 'Approved', 1, ?)
     ON DUPLICATE KEY UPDATE emp_name = VALUES(emp_name), role = 'Super Admin', approval = 'Approved', active = 1,
       access_hash = VALUES(access_hash)`,
    [alias, name, email, hashCode(code)]
  );
  await db.query(
    `INSERT INTO directory (alias, email, emp_name, added_by) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE email = VALUES(email), emp_name = VALUES(emp_name)`,
    [alias, email, name, alias]
  );
  console.log(alias + " is now an active Super Admin. Sign in at the IMS web address.");
}

main()
  .catch((error) => {
    console.error("Could not add the Super Admin: " + error.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());

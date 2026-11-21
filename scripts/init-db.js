"use strict";

// Creates missing tables and brings older tables up to date (safe to run again).
// With --sample it also loads the sample lab into an empty database.
const mysql = require("mysql2/promise");
const config = require("../src/config");
const { upgradeTables } = require("../src/migrate");

async function main() {
  const conn = await mysql.createConnection(config.db);
  const changes = await upgradeTables(conn);
  await conn.end();
  if (changes.length) console.log("Database brought up to date: " + changes.join(", ") + ".");
  console.log("Tables are ready in database " + config.db.database + ".");

  if (process.argv.includes("--sample")) {
    const { loadSample } = require("../src/sample");
    const loaded = await loadSample(false);
    console.log(loaded
      ? "Sample data loaded. Sign in as sa001@lab.example with password Lab@1001."
      : "The database already has accounts, so the sample data was not loaded.");
  } else {
    const db = require("../src/db");
    const admins = await db.one("SELECT COUNT(*) AS n FROM users WHERE role = 'Super Admin' AND active = 1");
    if (!Number(admins.n)) console.log("Next: run  npm run create-admin  to add the first Super Admin.");
  }
  await require("../src/db").pool.end();
}

main().catch((error) => {
  console.error("Could not set up the database: " + error.message);
  process.exit(1);
});

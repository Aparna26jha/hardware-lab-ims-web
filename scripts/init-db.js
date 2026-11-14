"use strict";

// Creates the tables (safe to run again). With --sample it also loads the sample lab into an empty database.
const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");
const config = require("../src/config");

async function main() {
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  const schema = fs.readFileSync(path.join(config.root, "db", "schema.sql"), "utf8");
  await conn.query(schema);
  await conn.end();
  console.log("Tables are ready in database " + config.db.database + ".");

  if (process.argv.includes("--sample")) {
    const { loadSample } = require("../src/sample");
    const loaded = await loadSample(false);
    console.log(loaded
      ? "Sample data loaded. Sign in as SA001 with code 1001."
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

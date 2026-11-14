"use strict";

// Takes one backup now. Windows Task Scheduler can also run this.
const { backupNow } = require("../src/backup");
const db = require("../src/db");

backupNow("command line")
  .then((file) => console.log("Backup saved: " + file))
  .catch((error) => {
    console.error("Backup failed: " + error.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());

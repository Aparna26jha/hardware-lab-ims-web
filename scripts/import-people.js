"use strict";

// Same as Accounts → Import people from CSV, from the command line:
//   npm run import-people -- people.csv
// See src/people-import.js for the columns.
const fs = require("node:fs");
const readline = require("node:readline/promises");
const db = require("../src/db");
const { importPeople } = require("../src/people-import");

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Give the file name, for example:  npm run import-people -- people.csv");
  const text = fs.readFileSync(file, "utf8");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const password = (await rl.question("Common first password for the new accounts (at least 8 characters): ")).trim();
  rl.close();
  const result = await importPeople(text, password);
  console.log("Accounts created: " + result.created + ". Existing accounts updated (password kept): " + result.updated + ".");
  if (result.problems.length) console.log("Not imported:\n  " + result.problems.join("\n  "));
  console.log("Everyone new signs in with their mail ID and the common first password, and must then choose their own.");
}

main()
  .catch((error) => {
    console.error("Could not import: " + error.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());

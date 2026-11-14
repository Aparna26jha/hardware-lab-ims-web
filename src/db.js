"use strict";

const mysql = require("mysql2/promise");
const config = require("./config");

const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
  charset: "utf8mb4"
});

async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function one(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

// Runs work(conn) inside one transaction: everything is saved, or nothing is.
async function transaction(work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work({
      query: async (sql, params) => (await conn.execute(sql, params))[0],
      one: async (sql, params) => (await conn.execute(sql, params))[0][0] || null
    });
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, one, transaction };

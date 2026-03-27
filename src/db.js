const mysql = require("mysql2/promise");
const config = require("./config");

function createDbPool() {
  if (config.mysqlUrl) {
    return mysql.createPool({
      uri: config.mysqlUrl,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
  }

  return mysql.createPool({
    host: config.mysqlHost,
    port: config.mysqlPort,
    user: config.mysqlUser,
    password: config.mysqlPassword,
    database: config.mysqlDatabase,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  });
}

const pool = createDbPool();

async function testDbConnection() {
  const connection = await pool.getConnection();

  try {
    const [rows] = await connection.query("SELECT 1 AS ok");
    return rows[0];
  } finally {
    connection.release();
  }
}

module.exports = {
  pool,
  testDbConnection,
};

const app = require("./app");
const { port } = require("./config");
const { testDbConnection } = require("./db");

async function start() {
  try {
    await testDbConnection();
    console.log("MySQL connection: OK");
  } catch (error) {
    console.error("MySQL connection failed:", error.message);
  }

  app.listen(port, "0.0.0.0", () => {
    console.log(`API running at http://0.0.0.0:${port}`);
    console.log(`Swagger docs at http://0.0.0.0:${port}/docs`);
  });
}

start();

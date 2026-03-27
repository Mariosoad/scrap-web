const express = require("express");
const { port } = require("./config");

function startFallbackHealthServer(error) {
  const fallback = express();

  fallback.get("/health", (_, res) => {
    res.status(200).json({
      ok: true,
      mode: "fallback",
      detail: "Main app failed to load. Check runtime logs.",
    });
  });

  fallback.listen(port, "0.0.0.0", () => {
    console.error("Main app boot failed. Fallback health server is running.");
    console.error("Boot error:", error?.stack || error?.message || String(error));
    console.log(`Fallback running at http://0.0.0.0:${port}`);
  });
}

async function start() {
  let app;
  try {
    app = require("./app");
  } catch (error) {
    startFallbackHealthServer(error);
    return;
  }

  app.listen(port, "0.0.0.0", () => {
    console.log(`API running at http://0.0.0.0:${port}`);
    console.log(`Swagger docs at http://0.0.0.0:${port}/docs`);
  });

  // Do not block startup on external dependencies (e.g. managed MySQL).
  // This keeps /health available for platform health checks.
  try {
    const { testDbConnection } = require("./db");
    await testDbConnection();
    console.log("MySQL connection: OK");
  } catch (error) {
    console.error("MySQL connection failed:", error.message);
  }
}

start();

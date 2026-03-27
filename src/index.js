const app = require("./app");
const { port } = require("./config");

app.listen(port, "0.0.0.0", () => {
  console.log(`API running at http://0.0.0.0:${port}`);
  console.log(`Swagger docs at http://0.0.0.0:${port}/docs`);
});

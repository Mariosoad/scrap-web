const swaggerJSDoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Leads Enrichment API",
      version: "1.0.0",
      description:
        "API para descubrir empresas con OpenStreetMap y enriquecer contactos desde sus websites publicos.",
    },
    servers: [{ url: "http://localhost:3000" }],
  },
  apis: ["./src/app.js"],
};

module.exports = swaggerJSDoc(options);

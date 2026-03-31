const swaggerJSDoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Leads Enrichment API",
      version: "1.0.0",
      description:
        "API para descubrir empresas del ecosistema vivienda/construcción (inmobiliaria, arquitectura, constructoras, ferreterías, mueblerías, oficios, etc.) en Argentina vía OpenStreetMap; el email puede venir de OSM o del sitio web.",
    },
    // Use same origin where docs are served (Railway/local/dev).
    servers: [{ url: "/" }],
  },
  apis: ["./src/app.js"],
};

module.exports = swaggerJSDoc(options);

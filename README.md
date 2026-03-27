# Leads API (Node.js + Express + Swagger)

API para:
1. Buscar empresas con OpenStreetMap (Overpass).
2. Entrar al sitio publico de cada empresa.
3. Extraer solo estos campos: nombre, email y direccion.
4. Alcance fijo: Buenos Aires, Argentina.

## Requisitos

- Node.js 18+
- Sin API key de Google

## Instalacion

```bash
npm install
```

Crea un archivo `.env` basado en `.env.example`:

```env
PORT=3000
REQUEST_TIMEOUT_MS=12000
OVERPASS_API_URL=https://overpass-api.de/api/interpreter
OVERPASS_API_URLS=https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=info@gemdam.com
SMTP_PASS=cambiar_por_tu_password
SMTP_FROM=info@gemdam.com
```

## Ejecutar

```bash
npm start
```

- Swagger UI: `http://localhost:3000/docs`
- Health: `http://localhost:3000/health`

## Deploy en Railway

Este repo ya incluye `railway.json` y el servidor escucha en `0.0.0.0` (Railway lo requiere).

- **Crear proyecto**: en Railway → New Project → Deploy from GitHub (o sube el repo).
- **Variables**: en Railway → Variables, carga las mismas que en `.env.example` (especialmente SMTP).  
  Railway define `PORT` automáticamente; la app lo toma desde `process.env.PORT`.
- **Start command**: queda configurado como `npm start`.
- **Healthcheck**: Railway usa `GET /health`.

Cuando termine el deploy:

- **Swagger**: `https://<tu-app>.up.railway.app/docs`
- **OpenAPI**: `https://<tu-app>.up.railway.app/openapi.json`

## Endpoint principal

`POST /api/leads/scrape`

Solo devuelve leads que tengan `email` (nunca `null` en la lista final).

Body ejemplo:

```json
{
  "category": "inmobiliaria",
  "maxResults": 10
}
```

Respuesta ejemplo:

```json
{
  "category": "inmobiliaria",
  "location": "Buenos Aires, Argentina",
  "searchArea": "Buenos Aires, Argentina",
  "count": 2,
  "leads": [
    {
      "businessName": "Empresa 1",
      "email": "info@empresa1.com",
      "address": "Av. Corrientes 1234, Buenos Aires, Argentina",
      "sourceWebsite": "https://empresa1.com"
    }
  ]
}
```

## Nota importante de cumplimiento

- Usa OpenStreetMap/Overpass para descubrimiento de negocios.
- El email se extrae desde websites publicos de cada empresa.
- Si un endpoint Overpass falla por timeout (504), la API intenta automaticamente con mirrors.

## Endpoint de envio de email

`POST /api/email/send`

Body ejemplo:

```json
{
  "to": "cliente@empresa.com",
  "subject": "Propuesta comercial",
  "text": "Hola, te comparto nuestra propuesta."
}
```

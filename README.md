# Leads API (Node.js + Express + Swagger)

API para:
1. Buscar empresas con OpenStreetMap (Overpass).
2. Entrar al sitio publico de cada empresa.
3. Extraer solo estos campos: nombre, email y direccion.
4. Alcance fijo: Argentina (bbox aproximado del país en OpenStreetMap).

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

Por defecto (`scrapeWebsites: false`) la API deja de consultar Overpass en cuanto tiene suficientes POIs para armar la página (`offset` + `maxResults`), devuelve hasta `maxResults` y el `email` puede ser `null` si solo hay web en OSM. En base de datos solo se insertan filas que tengan email (`skippedMissingEmail` en la respuesta). Con `scrapeWebsites: true` se intenta sacar el mail del sitio (mucho mas lento).

Body ejemplo (sector completo en Argentina — inmobiliaria, constructoras, arquitectura, remates/martilleros, etc.):

```json
{
  "maxResults": 25,
  "offset": 0,
  "scrapeWebsites": false
}
```

- `category` (opcional): si lo envías, se acota a un rubro (ej. `inmobiliaria`, `arquitectura`). Si lo omitís, se unen todos los filtros del sector.
- `maxResults` (o `maxResult`): cantidad maxima de leads por request (1 a 2000). Sin `offset` equivale a pedir esa cantidad desde el inicio.
- `offset`: posicion inicial dentro del lote descubierto para la siguiente tanda.
- `scrapeWebsites` (opcional, default `false`): si es `true`, intenta extraer email desde la web cuando no viene en OSM.

Respuesta ejemplo:

```json
{
  "category": null,
  "rubro": "sector-construccion-inmobiliario",
  "location": "Argentina",
  "searchArea": "Argentina",
  "maxResults": 25,
  "offset": 0,
  "nextOffset": 25,
  "hasMore": true,
  "totalBusinessesDiscovered": 312,
  "count": 2,
  "insertedCount": 2,
  "skippedCount": 0,
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

- Usa OpenStreetMap/Overpass para descubrimiento de negocios (tags de inmobiliaria, arquitectura, construcción, remates, etc.).
- El email se toma primero de datos publicos en OSM (`contact:email`) y, si hace falta y hay web, del sitio.
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

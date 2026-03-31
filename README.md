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

Solo devuelve leads que tengan `email` (nunca `null` en la lista final). El email puede venir de tags OSM (`contact:email` / `email`) o del scrape del sitio si hay `website` en OSM.

Body ejemplo (sector completo en Argentina — inmobiliaria, constructoras, arquitectura, remates/martilleros, etc.):

```json
{
  "maxResults": 25,
  "offset": 0
}
```

- `category` (opcional): si lo envías, se acota a un rubro (ej. `inmobiliaria`, `arquitectura`). Si lo omitís, se unen todos los filtros del sector.
- `maxResults`: cantidad maxima de leads a devolver por tanda (1 a 200).
- `offset`: posicion inicial dentro del lote descubierto para la siguiente tanda.

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

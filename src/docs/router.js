// GET /            → interactive API explorer (Swagger UI)
// GET /openapi.json → the machine-readable spec
import express from 'express';
import { buildSpec } from './openapi.js';

export const docsRouter = express.Router();

let cachedSpec = null;
const spec = () => (cachedSpec ??= buildSpec());

docsRouter.get('/openapi.json', (_req, res) => res.json(spec()));

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Backend API — explorer</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
<style>
  body { margin: 0; background: #0f1117; }
  .topbar { display: none; }
  header.hero {
    font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: #e6e8ef;
    padding: 28px 32px; border-bottom: 1px solid #23273a;
    background: linear-gradient(120deg, #141827, #0f1117);
  }
  header.hero h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: -.01em; }
  header.hero p { margin: 0; color: #9aa2b8; }
  header.hero code { background: #1c2133; padding: 1px 6px; border-radius: 4px; color: #cfd6ea; }
  #swagger { background: #fff; }
</style>
</head>
<body>
<header class="hero">
  <h1>Backend API</h1>
  <p>Sign in with <code>POST /auth/v1/token?grant_type=password</code>, press <strong>Authorize</strong>,
     paste the <code>access_token</code>, then try any endpoint below.
     Raw spec: <code>/openapi.json</code>.</p>
</header>
<div id="swagger"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
<script>
  window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger',
    deepLinking: true,
    persistAuthorization: true,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: true,
    defaultModelsExpandDepth: -1,
    docExpansion: 'list',
  });
</script>
</body>
</html>`;

const send = (_req, res) => res.type('html').send(page);
docsRouter.get('/', send);
docsRouter.get('/docs', send);

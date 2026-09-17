/**
 * The API documentation the server hosts about itself: the Swagger page, its assets, and the
 * OpenAPI document with the server URL rewritten to where this server actually listens.
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (the `/`, `/openapi.json` and `/docs/*` arms).
 * The files are embedded from the app's `src-tauri/static` by `npm run static:import`.
 *
 * Only the landing page carries CORS headers; the JSON and the assets never did, and a browser page
 * on another origin has no business fetching them.
 */

import { sendWhole } from './wire.js'
import type { Exchange } from './exchange.js'
import { OPENAPI_JSON, SWAGGER_UI_BUNDLE_JS, SWAGGER_UI_CSS } from './static-assets.generated.js'
import { isJsonObject, serdeToString } from '../shims/index.js'
import type { JsonValue } from '../shims/index.js'

const DOCS_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>API Docs</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" type="text/css" href="/docs/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/swagger-ui-bundle.js"></script>
  <script>
  window.onload = () => {
    SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
    });
  };
  </script>
</body>
</html>
    `

/** Answer a documentation route; `false` when the path is not one. Only GET reaches here. */
export function serveStatic(ex: Exchange): boolean {
  switch (ex.path) {
    case '/openapi.json':
      sendWhole(ex.res, 200, [['Content-Type', 'application/json']], openapiFor(ex))
      return true
    case '/':
      sendWhole(ex.res, 200, [['Content-Type', 'text/html'], ...ex.cors], DOCS_HTML)
      return true
    case '/docs/swagger-ui.css':
      sendWhole(ex.res, 200, [['Content-Type', 'text/css']], SWAGGER_UI_CSS)
      return true
    case '/docs/swagger-ui-bundle.js':
      sendWhole(ex.res, 200, [['Content-Type', 'application/javascript']], SWAGGER_UI_BUNDLE_JS)
      return true
    default:
      return false
  }
}

/** The OpenAPI document with every `servers[].url` pointing at this server; verbatim if unparsable. */
function openapiFor(ex: Exchange): string {
  let spec: JsonValue
  try {
    spec = JSON.parse(OPENAPI_JSON) as JsonValue
  } catch {
    return OPENAPI_JSON
  }
  const servers = isJsonObject(spec) ? spec['servers'] : undefined
  if (Array.isArray(servers)) {
    const url = `http://${ex.config.host}:${ex.config.port}${ex.config.prefix}`
    for (const server of servers) {
      if (isJsonObject(server) && Object.prototype.hasOwnProperty.call(server, 'url')) server['url'] = url
    }
  }
  return serdeToString(spec)
}

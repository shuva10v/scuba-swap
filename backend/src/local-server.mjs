/**
 * Local dev server — the same handler the Lambda runs, behind a plain HTTP
 * listener. `npm run dev` in backend/.
 *
 * Reads the key from RP_SIGNING_KEY. That is fine locally and NOT fine in
 * production, where it comes from Secrets Manager; see handler.mjs.
 *
 * CORS is permissive here because in development Vite serves the SPA on a
 * different port. In production there is no CORS at all: CloudFront puts the SPA
 * and /api/* on one origin, which is the main reason for fronting the API with
 * the CDN rather than exposing API Gateway directly.
 */

import { createServer } from "node:http";
import { handler } from "./handler.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const PATH = "/api/rp-signature";

if (!process.env.RP_SIGNING_KEY) {
  console.error("RP_SIGNING_KEY is not set — start with:");
  console.error("  RP_SIGNING_KEY=0x<64 hex> ALLOWED_ACTIONS=world-demo-v2 npm run dev\n");
  process.exit(1);
}
if (!process.env.ALLOWED_ACTIONS) {
  console.error("ALLOWED_ACTIONS is not set — the handler fails closed without it.");
  process.exit(1);
}

createServer((req, res) => {
  const cors = {
    "access-control-allow-origin": process.env.DEV_ORIGIN ?? "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  if (!req.url?.startsWith(PATH)) {
    res.writeHead(404, { "content-type": "application/json", ...cors }).end('{"error":"not_found"}');
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const event = {
      requestContext: { http: { method: req.method } },
      body: Buffer.concat(chunks).toString("utf8"),
    };
    try {
      const out = await handler(event);
      res.writeHead(out.statusCode, { ...out.headers, ...cors }).end(out.body);
      console.log(`${req.method} ${req.url} -> ${out.statusCode}`);
    } catch (err) {
      console.error(err);
      res.writeHead(500, { "content-type": "application/json", ...cors }).end('{"error":"internal"}');
    }
  });
}).listen(PORT, () => {
  console.log(`RP signing service on http://127.0.0.1:${PORT}${PATH}`);
  console.log(`allowed actions: ${process.env.ALLOWED_ACTIONS}`);
});

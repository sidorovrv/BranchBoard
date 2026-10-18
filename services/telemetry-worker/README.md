# Branchboard telemetry receiver

A Cloudflare Worker with a D1 database. `POST /v1/daily` accepts one schema 1 payload (at most 8 KB), stores it with the receive date and answers 204. A payload that repeats a `payloadId` is ignored. Once 5000 payloads are stored for the receive date, further payloads answer 429 until the next date. Other requests answer 404, an oversized body 413 and a body that does not match the schema 400. The Worker reads neither the request IP nor its headers, and Workers Logs are off.

The payload is described by `isDailyPayload` in `packages/core/src/telemetrySchema.ts`, which the Worker and the app share.

## Deploy

From this folder in PowerShell:

```powershell
npx wrangler login
npx wrangler d1 create branchboard-telemetry
npx wrangler d1 execute branchboard-telemetry --remote --file schema.sql
npx wrangler deploy
```

`wrangler d1 create` prints the database id for `database_id` in `wrangler.toml`. `wrangler deploy` prints the `*.workers.dev` address for `TELEMETRY_URL` in `packages/server/src/telemetry.ts`.

## Query

Daily active installs by version:

```powershell
npx wrangler d1 execute branchboard-telemetry --remote --command "SELECT json_extract(payload_json,'$.day') AS day, json_extract(payload_json,'$.app.version') AS version, COUNT(*) FROM daily GROUP BY day, version ORDER BY day"
```

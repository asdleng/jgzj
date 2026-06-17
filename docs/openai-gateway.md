# JGZJ OpenAI Gateway

This backend can expose an OpenAI-compatible relay at `/v1/*`.

## Important account boundary

Use an OpenAI Platform API key as `OPENAI_GATEWAY_UPSTREAM_API_KEY`. A ChatGPT
Pro subscription is not the same credential surface as the OpenAI API, and API
usage is configured and billed through the platform account.

## Runtime variables

Add these to `/home/admin1/jgzj/.runtime/jgzj-site.env`:

```bash
OPENAI_GATEWAY_ENABLED=true
OPENAI_GATEWAY_UPSTREAM_BASE_URL=https://api.openai.com
OPENAI_GATEWAY_UPSTREAM_API_KEY=sk-proj-...
OPENAI_GATEWAY_UPSTREAM_ORGANIZATION=
OPENAI_GATEWAY_UPSTREAM_PROJECT=
OPENAI_GATEWAY_SUBKEYS=default:jgzj-subkey-change-me
OPENAI_GATEWAY_RATE_LIMIT_PER_MINUTE=120
OPENAI_GATEWAY_TIMEOUT_MS=600000
OPENAI_GATEWAY_MAX_BODY_BYTES=26214400
OPENAI_GATEWAY_CORS_ORIGINS=
OPENAI_GATEWAY_LOG_PATH=.runtime/openai-gateway-requests.jsonl
```

`OPENAI_GATEWAY_SUBKEYS` accepts either comma-separated `name:key` pairs or a
JSON object:

```bash
OPENAI_GATEWAY_SUBKEYS='{"cold":"jgzj_cold_xxx","ops":"jgzj_ops_xxx"}'
```

For less secret-bearing env files, use SHA-256 hashes instead:

```bash
printf '%s' 'jgzj-subkey-change-me' | sha256sum
OPENAI_GATEWAY_SUBKEY_HASHES=default:<sha256-hex>
```

## Client usage

Point OpenAI-compatible clients to:

```text
https://ai-getway.jgzj.dev/v1
```

Use the gateway subkey as the bearer token. The server replaces it with the real
upstream API key before forwarding.

```bash
curl https://ai-getway.jgzj.dev/v1/models \
  -H "Authorization: Bearer jgzj-subkey-change-me"
```

## DNS and reverse proxy

The current site process listens on `127.0.0.1:8888` and already serves `/v1/*`.
Point `ai-getway.jgzj.dev` to the server or existing tunnel, then reverse proxy
that host to the same backend. Keep TLS on the public edge.

## Operational notes

- Request metadata is appended to `.runtime/openai-gateway-requests.jsonl`.
- Upstream response bodies are streamed through; prompt and completion content is
  not logged by this gateway.
- `/api/openai-gateway/status` reports configuration state to authenticated
  `ai:chat` users.

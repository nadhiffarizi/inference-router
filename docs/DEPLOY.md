# Deploy runbook — self-hosted box + NGINX

Deploy target (per DECISIONS.md D9): this box, systemd + NGINX, Cloudflare
DNS subdomain. Assume the repo lives at `/home/kreasiodigital/repo/inference-router`.

## 1. Build

```bash
npm install
npm run build            # gateway/dist + console/dist
npm run build:kb         # data/kb.json + data/eval.json (first run only)
cp gateway/.env.example gateway/.env   # fill OPENROUTER_API_KEY + tier models
```

Credentials via env are appended automatically: `SEED_TENANTS` and
`SEED_USERS` (see `.env.example`) seed `ops`/`demo` keyless, `stress`/`eval`
with fixture keys, and the two console accounts.

## 2. Fresh DB for production

```bash
rm -f gateway/data/gateway.sqlite*   # first boot recreates + seeds
```

## 3. systemd — `/etc/systemd/system/inference-router.service`

```ini
[Unit]
Description=Mini Inference Router gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/kreasiodigital/repo/inference-router/gateway
Environment=NODE_ENV=production
Environment=COOKIE_SECURE=true
EnvironmentFile=/home/kreasiodigital/repo/inference-router/gateway/.env
ExecStart=/usr/bin/node --require /home/kreasiodigital/repo/inference-router/node_modules/tsx/dist/preflight.cjs dist/server.js
Restart=always
RestartSec=2
User=kreasiodigital

[Install]
WantedBy=multi-user.target
```

`sudo systemctl daemon-reload && sudo systemctl enable --now inference-router`

Notes:
- `dist/server.js` is plain ESM — the tsx preflight line is only needed while
  running TS sources; drop `--require …` and use `node dist/server.js` if you
  build first.
- `COOKIE_SECURE=true` — the session cookie requires HTTPS (Cloudflare terminates TLS in front).
- Demo-fallback env (`ROUTING_CHAIN`, `MOCK_FAILURE_*`) belongs in dev only —
  leave it unset in production so routing is pure policy.

## 4. NGINX

```nginx
server {
    listen 80;
    server_name router.<your-domain>;

    root /home/kreasiodigital/repo/inference-router/console/dist;
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    # gateway API + SSE
    location /v1/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;          # SSE must not buffer
        proxy_read_timeout 300s;
    }
}
```

TLS: Cloudflare-proxied subdomain (flexible or full mode both work; the SSE
needs `proxy_buffering off` either way). `trustProxy` is on in the gateway, so
`X-Forwarded-Proto` keeps `secure` cookies and protocol detection correct.

## 5. Verify

```bash
curl https://router.<domain>/v1/health
# console: https://router.<domain>/ → login team@demo.local / mekari-demo-2026
# flow: issue key → copy → paste into playground → ask a question →
#       watch routing/retrieval/metering; Usage; admin login → Observability
```

## 6. Notes

- Quota counters reset at UTC midnight; restart-safe (SQLite WAL).
- Update flow: `git pull && npm install && npm run build && sudo systemctl restart inference-router`.
- Console accounts are seeded from `SEED_USERS`; change passwords there when
  making the demo public.
- Sessions are long-lived (30d cookie) by demo decision; logs/restarts don't
  log anyone out (sessions live in SQLite).
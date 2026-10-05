# Deploy runbook — self-hosted box + NGINX

Deploy target (per DECISIONS.md D9): this box, Cloudflare DNS subdomain. The
primary path is **Docker** (one container serves the gateway *and* the built
console on :3000, exposed only on `127.0.0.1:4000`); NGINX fronts it. Assume
the repo lives at `/home/kreasiodigital/repo/inference-router`.

## 1. Configure

```bash
cp gateway/.env.example gateway/.env   # fill OPENROUTER_API_KEY + tier models
npm run build:kb                       # data/kb.json (first run only)
```

Credentials via env are seeded on first boot: `SEED_TENANTS` and `SEED_USERS`
(see `.env.example`) seed `ops`/`demo` keyless, `stress`/`eval` with fixture
keys, and the two console accounts.

## 2. Docker

```bash
docker compose build
docker compose up -d
```

The compose file pins: `PORT=3000` (in-container), `CONSOLE_DIST=/app/console/dist`
(gateway serves the console — one origin), `COOKIE_SECURE=true` (TLS terminates
in front), binds `127.0.0.1:4000:3000` so the container is **not** reachable on
the public interface, mounts `./gateway/data` for SQLite persistence, and runs
as the host account (`user: "1001:1001"` — adjust if you deploy as another user).

```bash
curl http://127.0.0.1:4000/v1/health     # {"status":"ok"}
```

## 3. NGINX

The vhost is **not shipped in the repo** — it names this box's domain and the
Cloudflare ranges it trusts, which is deployment topology, not source. Write
it on the server (or version it privately); the repo-relevant contract is its
behaviour:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

What the vhost does (reproduce this on your box):

- `location / { proxy_pass http://127.0.0.1:4000; ... }` — proxies
  *everything* (console and API, one origin) to the compose map's host port.
- `proxy_buffering off` and `proxy_cache off` — SSE must stream, or answers
  arrive in bursts (the gateway also sends `x-accel-buffering: no`).
- `proxy_read_timeout 300s` — tier-B streams can outlast a page request.
- `client_max_body_size 2m` — the gateway's own limit is stricter (1 MiB).
- Behind Cloudflare: restore the real client IP from `CF-Connecting-IP`
  (`set_real_ip_from` + Cloudflare's published ranges) so the logs aren't all
  Cloudflare edge IPs.

TLS: run

```bash
sudo certbot --nginx -d router.kreasiodigital.com
```

(or terminate TLS at Cloudflare; `trustProxy` is on, so `X-Forwarded-Proto`
keeps `secure` cookies and protocol detection correct).

## 4. Verify

```bash
curl https://router.kreasiodigital.com/v1/health
# console: https://router.kreasiodigital.com/ → login team@demo.local
# flow: issue key → copy → paste into playground → ask a question →
#       watch routing/retrieval/metering; Usage; admin login → Observability
```

## 5. Notes

- Quota counters reset at UTC midnight; restart-safe (SQLite WAL).
- Update flow: `git pull && docker compose build && docker compose up -d`.
- Console accounts are seeded from `SEED_USERS`; change passwords there when
  making the demo public.
- Sessions are long-lived (30d cookie) by demo decision; logs/restarts don't
  log anyone out (sessions live in SQLite).
- Demo-fallback env (`ROUTING_CHAIN`, `MOCK_FAILURE_*`) belongs in dev only —
  leave it unset so routing is pure policy.

---

# Alternative: bare systemd (no Docker)

## Build

```bash
npm install
npm run build            # gateway/dist + console/dist
```

## Fresh DB for production

```bash
rm -f gateway/data/gateway.sqlite*   # first boot recreates + seeds
```

## systemd — `/etc/systemd/system/inference-router.service`

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

## NGINX (bare path only — the docker path uses the repo rule)

Serve the console statically and proxy only `/v1/*` to the gateway process:

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

Verify and update as in the docker path (`git pull && npm run build && sudo
systemctl restart inference-router`).
# Deploy runbook — self-hosted box + NGINX

Deploy target (per DECISIONS.md D9): this box, systemd + NGINX, Cloudflare
DNS subdomain. Everything below assumes the repo lives at
`/home/kreasiodigital/repo/inference-router`.

## 1. Build

```bash
npm install
npm run build            # gateway/dist + console/dist
npm run build:kb         # data/kb.json + data/eval.json (first run only)
cp gateway/.env.example gateway/.env   # fill OPENROUTER_API_KEY, tiers
```

## 2. Reset DB for production (fresh seeds)

```bash
rm -f gateway/data/gateway.sqlite*
```

## 3. systemd unit — `/etc/systemd/system/inference-router.service`

```ini
[Unit]
Description=Mini Inference Router gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/kreasiodigital/repo/inference-router/gateway
# demo-fallback env vars belong in dev, not prod — leave defaults:
Environment=NODE_ENV=production
EnvironmentFile=/home/kreasiodigital/repo/inference-router/gateway/.env
ExecStart=/usr/bin/node --require /home/kreasiodigital/repo/inference-router/node_modules/tsx/dist/preflight.cjs dist/server.js
Restart=always
RestartSec=2
User=kreasiodigital

[Install]
WantedBy=multi-user.target
```

`sudo systemctl daemon-reload && sudo systemctl enable --now inference-router`

(Alternative without tsx preflight: `npm run build && node dist/server.js` —
`dist` is plain ESM; the `--require tsx preflight` line is only needed while
running TS sources directly.)

## 4. NGINX

```nginx
server {
    listen 80;
    server_name router.<your-domain>;

    # static console
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
        proxy_buffering off;          # SSE must not buffer
        proxy_read_timeout 300s;
    }
}
```

TLS: Cloudflare-proxied subdomain → origin over HTTP or an origin certificate
under `/etc/nginx/ssl/` (flexible or full mode both work; the SSE needs
`proxy_buffering off` either way).

## 5. Verify

```bash
curl https://router.<domain>/v1/health
curl -s https://router.<domain>/v1/chat \
  -H "Authorization: Bearer sk_demo_key_0000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello"}'
```

Console: `https://router.<domain>/` → playground + usage.

## 6. Notes

- Quota counters reset at UTC midnight; restart-safe (SQLite WAL).
- Update flow: `git pull && npm run build && sudo systemctl restart inference-router`.
- Tenant keys are seed fixtures (see `SEED_TENANTS`); regenerate before a
  public demo and they're hashed in the DB anyway.
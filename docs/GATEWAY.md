# QRIS Payment Gateway — Deploy & Wiring

## What this is
A static QRIS turned into a payment gateway. The checkout page mints a
dynamic QRIS with a **unique amount** per transaction. When the customer
pays, the merchant phone's payment-app notification ("Anda menerima Rp X")
is forwarded by the **NotificationListener** app to `POST /webhook`, which
matches the amount to the pending invoice and marks it paid.

## Environment
| Var | Required | Meaning |
|-----|----------|---------|
| `STATIC_QRIS` | yes | Your merchant static QRIS payload (tag 00..63) |
| `API_KEY` | yes | Shared secret; must equal the app's API Key |
| `PORT` | no | Default 3000 |
| `INVOICE_TTL_MS` | no | Pending invoice lifetime, default 600000 (10 min) |
| `MAX_OFFSET` | no | Max rupiah added for uniqueness, default 999 |
| `DB_PATH` | no | Path to the SQLite database file, default `gateway.db` |

## Deploy to a VPS (Docker)
```bash
docker build -t qris-gateway .
docker run -d --name qris-gateway --restart unless-stopped -p 3000:3000 \
  -e STATIC_QRIS="..." -e API_KEY="a-strong-secret" \
  -e DB_PATH=/data/gateway.db -v /srv/qris-data:/data \
  qris-gateway
```
Note: mount the persistence volume at a dedicated data directory (e.g. `/data`)
and point `DB_PATH` into it — do **not** mount over `/app`, since that hides
the app's `dist/`, `src/`, and `node_modules` built into the image.

## Public HTTPS (required — the phone must reach it)
The NotificationListener endpoint must start with `https://`. Two options:

**A. Cloudflare Tunnel (no open ports, free TLS):**
```bash
cloudflared tunnel --url http://localhost:3000
```
Use the printed `https://<name>.trycloudflare.com` as the webhook base.
For a stable hostname, create a named tunnel bound to your domain.

**B. Reverse proxy (Caddy) on the VPS:**
```
gateway.example.com {
    reverse_proxy localhost:3000
}
```
Caddy provisions TLS automatically.

## Wire the NotificationListener app
- **Endpoint URL:** `https://<your-host>/webhook`
- **API Key:** the same `API_KEY` you set above
- **Filter Package:** your payment app package (e.g. `id.dana`), or enable
  "Forward semua aplikasi" during testing.

## Health check
`curl https://<your-host>/health` → `{"status":"OK"}`

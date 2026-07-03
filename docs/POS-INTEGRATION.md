# Integrasi POS / ERP dengan QRIS Payment Gateway

Panduan lengkap untuk menghubungkan sistem POS, kasir, atau ERP ke payment
gateway ini. Ditujukan untuk **developer** yang mengonsumsi API-nya.

---

## 1. Konsep singkat

Gateway ini mengubah satu **QRIS statis** merchant menjadi **QRIS dinamis
per transaksi**. Caranya: setiap invoice diberi **nominal unik** (nominal yang
diminta POS + 1..999 rupiah). Saat pelanggan membayar dengan nominal persis
itu, notifikasi mutasi di HP merchant ("Anda menerima Rp X") diteruskan oleh
aplikasi **NotificationListener** ke gateway, lalu gateway mencocokkan nominal
tersebut ke invoice yang `pending` dan menandainya `paid`.

**Yang perlu dipahami POS/ERP:**

- POS **membuat invoice** → menampilkan QR → **polling status** sampai `paid`.
- **Tidak ada callback/push dari gateway ke POS.** Konfirmasi lunas didapat
  dengan cara **polling** `GET /api/invoices/:id`. (Lihat §8 keterbatasan.)
- Pelanggan **wajib bayar nominal `uniqueAmount` persis** — bukan `baseAmount`.
- Pencocokan pakai nominal, jadi selisih 1..999 rupiah adalah kunci
  identifikasi transaksi.

```
POS/ERP                    Gateway                     HP Merchant
  |  POST /api/invoices       |                              |
  |-------------------------->|  simpan invoice (pending)    |
  |  { id, uniqueAmount,      |                              |
  |    qrString, expiresAt }  |                              |
  |<--------------------------|                              |
  |  render QR dari qrString  |                              |
  |                           |        pelanggan scan & bayar|
  |                           |   POST /webhook (nominal) <--|  (NotificationListener)
  |                           |  cocokkan → status=paid      |
  |  GET /api/invoices/:id    |                              |
  |-------------------------->|                              |
  |  { status: "paid" }       |                              |
  |<--------------------------|  (polling tiap 2-3 detik)    |
```

---

## 2. Base URL & autentikasi

| Hal | Nilai |
|-----|-------|
| Base URL produksi | `https://payment.bppunh.com` |
| Base URL lokal | `http://localhost:3000` |
| Format | JSON (`Content-Type: application/json`) |
| Satuan nominal | **Integer rupiah** (mis. `25000`, bukan `25000.00`) |
| Timestamp | **Epoch milidetik** (`Date.now()`) |

Ada **dua jalur** integrasi:

1. **Jalur publik (self-service)** — `POST /api/invoices`, `GET /api/invoices/:id`,
   `GET /api/merchants`, `GET /api/history`. **Tanpa auth.** Dipakai halaman
   checkout bawaan. Cocok untuk prototipe / QR mandiri.
2. **POS API terautentikasi (disarankan untuk POS/ERP produksi)** —
   `POST /api/pos/invoices` & `GET /api/pos/invoices/:id`, dilindungi header
   `X-API-Key` (= `apiKey` merchant). Mendukung **`orderId`**, **idempotensi**,
   dan **callback/webhook ber-signature ke POS** saat lunas. **Lihat §10.**

> ⚠️ Endpoint publik `/api/*` tidak berautentikasi — siapa pun yang tahu `id`
> bisa melihat invoice, dan `/api/history` membocorkan omzet. Untuk POS produksi
> gunakan **jalur #2 (§10)** dan jangan ekspos endpoint publik ke internet
> terbuka tanpa proteksi.

---

## 3. Referensi API

### 3.1 `GET /api/merchants` — daftar merchant

Dipakai bila satu gateway melayani beberapa merchant, untuk memilih
`merchantId`.

```
GET /api/merchants
200 OK
[
  { "id": "nh-pure-water", "name": "NH Pure Water" },
  { "id": "merchant-02",   "name": "Merchant 02" }
]
```

> Kalau hanya ada **satu** merchant, `merchantId` boleh dikosongkan di semua
> endpoint (gateway memakai satu-satunya merchant secara otomatis).

---

### 3.2 `POST /api/invoices` — buat transaksi

Endpoint utama POS. Membuat invoice baru dan mengembalikan QRIS dinamis.

**Request**
```json
{
  "merchantId": "nh-pure-water",   // opsional bila hanya 1 merchant
  "amount": 25000                   // WAJIB, integer rupiah, > 0
}
```

**Response `200 OK`** — objek Invoice lengkap (lihat §4):
```json
{
  "id": "8995bc3e2fb26917ff",
  "merchantId": "nh-pure-water",
  "baseAmount": 25000,
  "uniqueAmount": 25391,
  "qrString": "00020101021226...6304AB12",
  "status": "pending",
  "createdAt": 1751600692000,
  "expiresAt": 1751601292000,
  "paidAt": null
}
```

**Yang harus dilakukan POS dari response ini:**
1. Simpan `id` → dipakai untuk polling & rekonsiliasi.
2. Render QR dari **`qrString`** (lihat §5).
3. Tampilkan **`uniqueAmount`** ke pelanggan sebagai nominal yang harus dibayar.
4. Mulai polling status sampai `paid`/`expired` atau `expiresAt` terlewati.

**Error**
| Kode | Body | Sebab |
|------|------|-------|
| `400` | `{ "error": "merchantId is required" }` | >1 merchant tapi `merchantId` kosong |
| `400` | `{ "error": "amount must be a positive integer (rupiah)" }` | `amount` bukan integer > 0 |
| `404` | `{ "error": "unknown merchant: X" }` | `merchantId` tidak dikenal |
| `503` | `{ "error": "Could not allocate a unique amount; ..." }` | Terlalu banyak invoice `pending` (nominal unik habis) |

---

### 3.3 `GET /api/invoices/:id` — cek status (polling)

Cara POS mengetahui apakah sudah dibayar. Panggil berulang (mis. tiap 2-3
detik) sampai `status` berubah.

```
GET /api/invoices/8995bc3e2fb26917ff
200 OK
{ "id": "8995bc3e2fb26917ff", "status": "paid", "paidAt": 1751600750000, ... }
```

| Kode | Body | Arti |
|------|------|------|
| `200` | Invoice (§4) | Cek field `status`: `pending` / `paid` / `expired` |
| `404` | `{ "error": "not found" }` | `id` tidak ada |

Berhenti polling saat `status === "paid"` (sukses) atau `status === "expired"`
atau waktu sekarang > `expiresAt` (batal/kedaluwarsa).

---

### 3.4 `GET /api/history` — riwayat transaksi lunas (rekonsiliasi)

Mengembalikan daftar invoice **berstatus `paid`**, terbaru dulu, maksimal
**200** baris. Cocok untuk laporan/rekonsiliasi harian ERP.

```
GET /api/history                       # semua merchant
GET /api/history?merchantId=nh-pure-water   # per merchant
200 OK
[ { Invoice }, { Invoice }, ... ]      // hanya status "paid", urut paidAt desc
```

| Kode | Body | Sebab |
|------|------|-------|
| `200` | `Invoice[]` | OK |
| `404` | `{ "error": "unknown merchant: X" }` | `merchantId` tidak dikenal |

> Batas 200 baris tanpa paginasi. Untuk rekonsiliasi volume besar, ambil
> berkala lalu simpan di sisi ERP (dedup pakai `id`).

---

### 3.5 `GET /health` — health check

```
GET /health → 200 { "status": "OK" }
```

---

### 3.6 `POST /webhook/:merchantId` — (HANYA untuk device, bukan POS)

Didokumentasikan agar lengkap. Endpoint ini dipanggil aplikasi
NotificationListener di HP merchant, **bukan** oleh POS/ERP.

- Header wajib: `X-API-Key: <apiKey merchant>`
- Body: `{ "amountDetected": 25391 }` atau `{ "text": "Anda menerima Rp 25.391" }`
- Gateway mencocokkan nominal ke invoice `pending` merchant tsb.

Response: `{ "matched": true, "invoiceId": "..." }` atau `{ "matched": false }`.

---

## 4. Objek Invoice

Semua endpoint invoice mengembalikan bentuk yang sama.

| Field | Tipe | Keterangan |
|-------|------|------------|
| `id` | string | ID unik invoice (18 hex). Kunci utama untuk polling & rekonsiliasi. |
| `merchantId` | string | Merchant pemilik invoice. |
| `baseAmount` | number | Nominal yang **diminta POS** (harga jual). |
| `uniqueAmount` | number | Nominal yang **harus dibayar pelanggan** (= `baseAmount` + 1..999). Ini yang ditampilkan & jadi kunci pencocokan. |
| `qrString` | string | Payload EMVCo QRIS dinamis. Render jadi QR (§5). |
| `status` | string | `"pending"` \| `"paid"` \| `"expired"`. |
| `createdAt` | number | Epoch ms saat dibuat. |
| `expiresAt` | number | Epoch ms kedaluwarsa (default `createdAt` + 10 menit). |
| `paidAt` | number \| null | Epoch ms saat lunas; `null` bila belum. |

**Penting soal akuntansi:** pelanggan membayar `uniqueAmount`, yang **1..999
rupiah lebih besar** dari `baseAmount`. Selisih kecil ini adalah mekanisme
identifikasi. Simpan `baseAmount` sebagai harga jual dan `uniqueAmount` sebagai
kas diterima; selisihnya "pembulatan" yang diterima merchant.

### Siklus status
```
pending ──(bayar nominal cocok)──> paid      (final)
   └──────(lewat expiresAt)──────> expired   (final)
```
`paid` dan `expired` bersifat final — tidak berubah lagi.

---

## 5. Menampilkan QR

`qrString` adalah payload QRIS EMVCo mentah. Dua pilihan:

**A. Render sendiri di POS** (disarankan untuk POS/kasir):
Ubah `qrString` menjadi gambar QR dengan library apa pun, mis.
`qrcode` (Node), `qrcode` (Python), `endroid/qr-code` (PHP),
`ZXing` (Java/Android).

**B. Redirect ke halaman checkout bawaan gateway:**
```
https://payment.bppunh.com/checkout.html?merchant=<merchantId>
```
Halaman ini menangani input nominal, tampil QR, polling, dan status "LUNAS"
secara otomatis. Cocok kalau tidak mau membangun UI sendiri.

---

## 6. Alur integrasi yang disarankan

1. **(sekali)** `GET /api/merchants` → tentukan `merchantId` yang dipakai POS.
2. Saat kasir menekan "Bayar QRIS":
   `POST /api/invoices { merchantId, amount }` → simpan `id`, tampilkan QR dari
   `qrString`, tampilkan `uniqueAmount`.
3. **Polling** `GET /api/invoices/:id` tiap 2-3 detik:
   - `status === "paid"` → tandai lunas di POS, cetak struk, selesai.
   - `status === "expired"` atau lewat `expiresAt` → batalkan / buat ulang.
4. **(harian)** `GET /api/history?merchantId=...` untuk rekonsiliasi ke ERP.

> **Idempotensi:** `POST /api/invoices` **tidak idempoten** — tiap panggilan
> membuat invoice & nominal unik baru. Buat invoice **sekali** per checkout,
> lalu simpan `id`-nya. Jangan retry POST buta; kalau ragu, polling `id` yang
> sudah ada.

---

## 7. Contoh kode

### cURL
```bash
# buat invoice
curl -s -X POST https://payment.bppunh.com/api/invoices \
  -H 'Content-Type: application/json' \
  -d '{"merchantId":"nh-pure-water","amount":25000}'

# cek status
curl -s https://payment.bppunh.com/api/invoices/8995bc3e2fb26917ff
```

### Node.js / TypeScript
```ts
const BASE = "https://payment.bppunh.com";

async function createInvoice(merchantId: string, amount: number) {
  const res = await fetch(`${BASE}/api/invoices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merchantId, amount }),
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json(); // { id, uniqueAmount, qrString, expiresAt, ... }
}

async function waitPaid(id: string, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inv = await (await fetch(`${BASE}/api/invoices/${id}`)).json();
    if (inv.status === "paid") return inv;
    if (inv.status === "expired") throw new Error("expired");
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error("timeout");
}
```

### PHP (POS/ERP)
```php
<?php
$BASE = "https://payment.bppunh.com";

function post_json($url, $body) {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ["Content-Type: application/json"],
    CURLOPT_POSTFIELDS => json_encode($body),
  ]);
  $res = curl_exec($ch);
  return json_decode($res, true);
}

// 1) buat invoice
$inv = post_json("$BASE/api/invoices",
  ["merchantId" => "nh-pure-water", "amount" => 25000]);
$id = $inv["id"];
// tampilkan QR dari $inv["qrString"], nominal $inv["uniqueAmount"]

// 2) polling status
do {
  sleep(3);
  $cur = json_decode(file_get_contents("$BASE/api/invoices/$id"), true);
} while ($cur["status"] === "pending" && time() * 1000 < $inv["expiresAt"]);

if ($cur["status"] === "paid") { /* tandai lunas di POS */ }
```

### Python
```python
import time, requests
BASE = "https://payment.bppunh.com"

inv = requests.post(f"{BASE}/api/invoices",
                    json={"merchantId": "nh-pure-water", "amount": 25000}).json()
# render QR dari inv["qrString"], tampilkan inv["uniqueAmount"]

while True:
    cur = requests.get(f"{BASE}/api/invoices/{inv['id']}").json()
    if cur["status"] != "pending":
        break
    time.sleep(2.5)
print("LUNAS" if cur["status"] == "paid" else "GAGAL/EXPIRED")
```

---

## 8. Keterbatasan yang perlu diketahui

| Keterbatasan | Dampak & saran |
|--------------|----------------|
| **Webhook ke POS** | ✅ **Sudah ada** via POS API (§10): sertakan `callbackUrl` → gateway POST ber-signature saat lunas. Tetap sediakan polling sebagai cadangan (best-effort, 3× retry). |
| **Auth & idempotensi** | ✅ **Sudah ada** di jalur POS (`/api/pos/*`, header `X-API-Key`, `idempotencyKey`). Jalur publik `/api/invoices` tetap tanpa auth & tidak idempoten. |
| **Pencocokan berbasis nominal** | Dua invoice `pending` dengan `uniqueAmount` sama pada merchant sama bisa ambigu; gateway memilih yang **dibuat paling awal**. Rentang unik = `MAX_OFFSET`, jadi praktis **maks ~`MAX_OFFSET` invoice `pending` bersamaan per merchant** sebelum dapat `503`. |
| **TTL invoice** | Default 10 menit (`INVOICE_TTL_MS`). Setelah lewat → otomatis `expired`, tidak bisa dibayar. |
| **Nominal dibayar ≠ harga jual** | Pelanggan bayar `uniqueAmount` (lebih 1..`MAX_OFFSET`). Perlakukan di akuntansi (§4). |
| **Endpoint publik tanpa auth** | Jalur publik `/api/*` terbuka. Untuk POS produksi pakai jalur POS (§10) dan proteksi endpoint publik. |
| **Tanpa paginasi di history** | `GET /api/history` maks 200 baris. Ambil berkala & simpan di ERP. |

---

## 9. Rekomendasi produksi

- **Jaringan:** taruh gateway di jaringan internal / di belakang VPN atau
  reverse-proxy (mis. Nginx) dengan Basic Auth / mTLS untuk endpoint `/api/*`.
- **HTTPS wajib:** endpoint NotificationListener harus `https://` (lihat
  `docs/GATEWAY.md`).
- **Rekonsiliasi:** jangan andalkan hanya status polling — tarik `/api/history`
  harian dan cocokkan dengan pembukuan.
- **Timeout & retry:** hormati `expiresAt`; hentikan polling setelah itu.
- **Simpan mapping** `orderId POS ↔ invoice id` di sisi POS/ERP untuk audit.

---

## Ringkasan endpoint

| Method | Path | Untuk | Auth |
|--------|------|-------|------|
| `POST` | `/api/pos/invoices` | **Buat transaksi (POS, disarankan)** — orderId/callback/idempotensi | `X-API-Key` |
| `GET` | `/api/pos/invoices/:id` | **Cek status (POS, ter-scope merchant)** | `X-API-Key` |
| `GET` | `/api/merchants` | Daftar merchant | — |
| `POST` | `/api/invoices` | Buat transaksi (publik/self-service) | — |
| `GET` | `/api/invoices/:id` | Cek status (polling, publik) | — |
| `GET` | `/api/history` | Riwayat lunas / rekonsiliasi | — |
| `GET` | `/health` | Health check | — |
| `POST` | `/webhook/:merchantId` | Device notif (bukan POS) | `X-API-Key` |

---

## 10. POS API terautentikasi + callback (disarankan untuk produksi)

Jalur ini menambah **autentikasi**, **`orderId`**, **idempotensi**, dan
**callback ber-signature** ke POS — semua yang di §8 dulu belum ada.

### 10.1 Autentikasi

Semua endpoint POS butuh header `X-API-Key: <apiKey merchant>` (kunci per-merchant
yang sama di `MERCHANTS`). Key **mengidentifikasi merchant sekaligus mengautentikasi**.
Simpan **hanya di server POS**, jangan di JS browser.

### 10.2 `POST /api/pos/invoices` — buat invoice (POS)

**Request** (header `X-API-Key` wajib):
```json
{
  "amount": 15000,                    // WAJIB, integer rupiah > 0
  "orderId": "ORD-2026-0001",         // opsional: referensi order POS-mu
  "callbackUrl": "https://pos-mu.example.com/gw_callback.php", // opsional
  "idempotencyKey": "ORD-2026-0001"   // opsional: retry aman -> 1 invoice per order
}
```
`merchantId` **tidak perlu** — diambil dari API key. `callbackUrl` harus `http(s)://`.

**Response `200`**: objek Invoice + `orderId` + **`payUrl`** (halaman bayar siap pakai).
`callbackUrl` tidak pernah dikembalikan. Kirim ulang dengan `idempotencyKey` sama →
mengembalikan invoice yang sama (bukan bikin baru).

### 10.3 `GET /api/pos/invoices/:id` — cek status (ter-scope)

Header `X-API-Key` wajib. Hanya bisa membaca invoice milik merchant key tsb
(invoice merchant lain → `404`). Cek field `status`.

### 10.4 Callback saat lunas (webhook ke POS)

Jika invoice punya `callbackUrl`, saat lunas gateway **POST** JSON ke URL itu,
dengan header `X-Signature: sha256=<hmac>` di mana HMAC = `HMAC-SHA256(rawBody, apiKey merchant)`.

Body:
```json
{ "event":"invoice.paid", "id":"...", "orderId":"ORD-2026-0001",
  "merchantId":"...", "amount":15010, "baseAmount":15000, "paidAt":1783103600794 }
```
Balas `200` cepat. Gateway retry **3×** bila gagal, tapi callback **best-effort** —
tetap sediakan polling (§10.6) sebagai cadangan. **Verifikasi signature** sebelum percaya.

### 10.5 Contoh PHP — buat invoice + tampilkan QR

```php
<?php
const GW_BASE = 'https://payment.bppunh.com';
const GW_KEY  = getenv('GW_API_KEY');   // apiKey merchant — env, jangan hardcode
const GW_CB   = 'https://pos-mu.example.com/gw_callback.php';

function gw_create(int $amount, string $orderId): array {
    $ch = curl_init(GW_BASE . '/api/pos/invoices');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . GW_KEY],
        CURLOPT_POSTFIELDS => json_encode([
            'amount' => $amount, 'orderId' => $orderId,
            'callbackUrl' => GW_CB, 'idempotencyKey' => $orderId,
        ]),
        CURLOPT_TIMEOUT => 15,
    ]);
    $res = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    if ($code !== 200) throw new RuntimeException("Gateway $code: $res");
    return json_decode($res, true); // ['id','uniqueAmount','qrString','payUrl',...]
}

$inv = gw_create(15000, 'ORD-2026-0001');
// simpan: order -> $inv['id'], nominal ditunggu = $inv['uniqueAmount']
// Tampilkan QR — cara termudah: arahkan pelanggan ke payUrl (QR + nominal + status otomatis)
//   header('Location: '.$inv['payUrl']); exit;
// atau render sendiri dari $inv['qrString'] (mis. composer require endroid/qr-code).
```

### 10.6 Contoh PHP — terima callback (verifikasi HMAC)

```php
<?php
// gw_callback.php
const GW_KEY = getenv('GW_API_KEY');
$raw = file_get_contents('php://input');
$expected = 'sha256=' . hash_hmac('sha256', $raw, GW_KEY);
if (!hash_equals($expected, $_SERVER['HTTP_X_SIGNATURE'] ?? '')) {
    http_response_code(401); exit('bad signature');   // constant-time compare
}
$e = json_decode($raw, true);
if (($e['event'] ?? '') === 'invoice.paid') {
    // idempoten: tandai lunas sekali (cek status order dulu). amount = uniqueAmount.
    mark_order_paid($e['orderId'], $e['id'], $e['amount']);
}
http_response_code(200); echo 'ok';
```

### 10.7 Polling cadangan (POS)

```php
function gw_status(string $id): string {
    $ch = curl_init(GW_BASE . '/api/pos/invoices/' . urlencode($id));
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER=>true,
        CURLOPT_HTTPHEADER=>['X-API-Key: '.GW_KEY], CURLOPT_TIMEOUT=>10]);
    $res = curl_exec($ch); curl_close($ch);
    return json_decode($res, true)['status'] ?? 'unknown'; // pending|paid|expired
}
```

### 10.8 Checklist keamanan POS

- [ ] `X-API-Key` hanya di **server** POS, tidak pernah di browser.
- [ ] Verifikasi `X-Signature` callback dengan `hash_equals` sebelum percaya.
- [ ] `mark_order_paid` **idempoten** (callback + polling bisa sama-sama memicu).
- [ ] `idempotencyKey = orderId` agar retry tak menggandakan invoice.
- [ ] Anggap **`uniqueAmount`** (bukan harga jual) sebagai nominal yang dibayar.

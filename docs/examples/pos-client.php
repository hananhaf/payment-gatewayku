<?php
/**
 * pos-client.php — klien minimal QRIS Payment Gateway untuk POS/ERP PHP.
 * Tanpa dependensi (cukup cURL bawaan). Salin file ini ke proyek POS-mu.
 *
 * Kredensial dibaca dari environment (JANGAN hardcode di sini):
 *   GW_BASE_URL   https://payment.bppunh.com
 *   GW_API_KEY    apiKey merchant (rahasia, setara password)
 *
 * Smoke test live:  GW_BASE_URL=... GW_API_KEY=... php pos-client.php demo 1000
 */

function gw_env(string $k): string {
  $v = getenv($k);
  if ($v === false || $v === '') throw new RuntimeException("env $k belum di-set");
  return $v;
}

/** POST /api/pos/invoices — buat invoice (auth via X-API-Key). Kirim idempotencyKey agar retry aman. */
function gw_create_invoice(int $amount, ?string $orderId = null, ?string $idempotencyKey = null): array {
  $body = ['amount' => $amount];
  if ($orderId !== null)        $body['orderId'] = $orderId;
  if ($idempotencyKey !== null) $body['idempotencyKey'] = $idempotencyKey;
  return gw_request('POST', '/api/pos/invoices', $body);
}

/** GET /api/pos/invoices/:id — baca invoice milik merchant ini. status: pending|paid|expired. */
function gw_get_invoice(string $id): array {
  return gw_request('GET', '/api/pos/invoices/' . rawurlencode($id));
}

function gw_request(string $method, string $path, ?array $body = null): array {
  $ch = curl_init(gw_env('GW_BASE_URL') . $path);
  $headers = ['X-API-Key: ' . gw_env('GW_API_KEY')];
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_TIMEOUT        => 15,
  ]);
  if ($body !== null) {
    $headers[] = 'Content-Type: application/json';
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
  }
  curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
  $raw = curl_exec($ch);
  if ($raw === false) throw new RuntimeException('gateway tak terjangkau: ' . curl_error($ch));
  $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  curl_close($ch);
  $data = json_decode($raw, true) ?? [];
  if ($code >= 400) throw new RuntimeException("gateway HTTP $code: " . ($data['error'] ?? $raw));
  return $data;
}

/**
 * (opsional) Verifikasi tanda tangan callback saat nanti pakai webhook (butuh URL publik HTTPS).
 * Panggil di endpoint callback-mu SEBELUM menandai order lunas.
 */
function gw_verify_callback(string $rawBody, string $signatureHeader): bool {
  $expected = 'sha256=' . hash_hmac('sha256', $rawBody, gw_env('GW_API_KEY'));
  return hash_equals($expected, $signatureHeader);
}

/* ---------------------------------------------------------------------------
 * POLA PAKAI DI POS (tanpa URL publik — cukup polling):
 *
 *   // 1) saat kasir buat tagihan:
 *   $inv = gw_create_invoice(25000, 'ORD-123', 'ORD-123');   // idempotencyKey = orderId
 *   // tampilkan ke pembeli: $inv['payUrl']  atau  Rp $inv['uniqueAmount']
 *   // simpan $inv['id'] di baris order.
 *
 *   // 2) cron tiap ~10 detik untuk order yang masih pending:
 *   $s = gw_get_invoice($orderRow['gw_invoice_id'])['status'];
 *   if ($s === 'paid')    markOrderPaid($orderRow);
 *   if ($s === 'expired') cancelOrder($orderRow);
 * ------------------------------------------------------------------------- */

// --- Smoke test (live): `php pos-client.php demo [amount]` — bikin 1 invoice pending, poll 3x, lalu berhenti.
if (PHP_SAPI === 'cli' && ($argv[1] ?? '') === 'demo') {
  $amount = (int)($argv[2] ?? 1000);
  $inv = gw_create_invoice($amount, 'DEMO-' . $amount, 'DEMO-' . $amount);
  printf("dibuat: id=%s  nominal=Rp%d  payUrl=%s\n", $inv['id'], $inv['uniqueAmount'], $inv['payUrl']);
  for ($i = 1; $i <= 3; $i++) {
    $s = gw_get_invoice($inv['id'])['status'];
    echo "poll $i: status=$s\n";
    if ($s !== 'pending') break;
    sleep(2);
  }
  echo "OK — auth & create & poll jalan. Invoice pending ini akan kedaluwarsa sendiri.\n";
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type express from "express";
import type { InvoiceStore } from "./invoices.ts";
import type { Invoice, InvoiceStatus, Merchant } from "./types.ts";

// Admin console auth. Single operator: one ADMIN_PASSWORD in env (like API_KEY /
// merchants). Login mints an HttpOnly, HMAC-signed session cookie — no user table,
// no new dependency. If ADMIN_PASSWORD is unset, the whole admin surface is disabled
// (503) so it can never be open with a blank password.

const COOKIE = "admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

/** The console is enabled only when a non-empty ADMIN_PASSWORD is configured. */
export function adminEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ADMIN_PASSWORD?.trim());
}

/** HMAC key for session cookies. Dedicated secret if set, else derived from the password. */
function sessionKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.ADMIN_SESSION_SECRET?.trim() || env.ADMIN_PASSWORD?.trim() || "";
}

/** Constant-time string compare (hash first so lengths never leak / mismatch-throw). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** A signed session token `${expiry}.${hmac}` valid until `expiry` (epoch ms). */
export function signSession(expiry: number, key: string): string {
  const mac = createHmac("sha256", key).update(String(expiry)).digest("hex");
  return `${expiry}.${mac}`;
}

/** Verify a session token's signature and expiry. Constant-time on the signature. */
export function verifySession(token: string, key: string, now: number): boolean {
  if (!token || !key) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const expiryStr = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expiry = Number(expiryStr);
  if (!Number.isInteger(expiry) || expiry < now) return false;
  const expected = createHmac("sha256", key).update(expiryStr).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCookie(req: express.Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function isAuthed(req: express.Request): boolean {
  return verifySession(readCookie(req, COOKIE) ?? "", sessionKey(), Date.now());
}

/** Gate a route: 503 if admin isn't configured, 401 if not logged in. */
export function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!adminEnabled()) {
    res.status(503).json({ error: "admin console disabled (set ADMIN_PASSWORD)" });
    return;
  }
  if (!isAuthed(req)) {
    res.status(401).json({ error: "login required" });
    return;
  }
  next();
}

function isHttps(req: express.Request): boolean {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim();
  return (proto || req.protocol) === "https";
}

/** Absolute base URL (scheme + host) from the request's forwarded headers. */
function baseUrl(req: express.Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers["host"] || "";
  return `${proto}://${host}`;
}

const VALID_STATUS: InvoiceStatus[] = ["pending", "paid", "expired"];

export function registerAdminRoutes(app: express.Express, store: InvoiceStore, merchants: Merchant[]): void {
  const byId = new Map(merchants.map((m) => [m.id, m]));

  // Brute-force throttle. Keyed on the TRUE peer (socket.remoteAddress), NEVER on the
  // spoofable X-Forwarded-For — else an attacker rotates that header for a fresh bucket
  // per request and the lockout never trips. A global ceiling backstops distributed
  // attempts across many real IPs.
  // ponytail: in-memory, single instance. Behind a proxy every client shares the proxy
  // IP (one bucket ≈ global), which is the safe default here; a restart clears a lockout.
  const PEER_LOCK = 8;
  const GLOBAL_LOCK = 30;
  const WINDOW_MS = 15 * 60 * 1000;
  const peers = new Map<string, { count: number; until: number }>();
  const global = { count: 0, until: 0 };
  const bump = (rec: { count: number; until: number }, now: number) => {
    if (rec.until <= now) {
      rec.count = 0;
      rec.until = now + WINDOW_MS;
    }
    rec.count += 1;
  };

  app.post("/api/admin/login", (req, res) => {
    if (!adminEnabled()) {
      res.status(503).json({ error: "admin console disabled (set ADMIN_PASSWORD)" });
      return;
    }
    const now = Date.now();
    const peerKey = req.socket.remoteAddress ?? "unknown";
    const peer = peers.get(peerKey) ?? { count: 0, until: 0 };
    const throttled =
      (peer.until > now && peer.count >= PEER_LOCK) || (global.until > now && global.count >= GLOBAL_LOCK);
    if (throttled) {
      res.status(429).json({ error: "too many attempts, try again later" });
      return;
    }
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!password || !safeEqual(password, process.env.ADMIN_PASSWORD!.trim())) {
      bump(peer, now);
      peers.set(peerKey, peer);
      bump(global, now);
      res.status(401).json({ error: "wrong password" });
      return;
    }
    peers.delete(peerKey);
    const expiry = now + SESSION_TTL_MS;
    res.cookie(COOKIE, signSession(expiry, sessionKey()), {
      httpOnly: true,
      sameSite: "strict",
      secure: isHttps(req),
      maxAge: SESSION_TTL_MS,
      path: "/",
    });
    res.json({ ok: true });
  });

  app.post("/api/admin/logout", (_req, res) => {
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  // Cheap probe for the UI to decide login-view vs dashboard. Also reports whether
  // the console is configured at all (so the page can show a setup hint).
  app.get("/api/admin/me", (req, res) => {
    res.json({ enabled: adminEnabled(), authed: adminEnabled() && isAuthed(req) });
  });

  app.get("/api/admin/stats", requireAdmin, async (_req, res) => {
    res.json(await store.stats());
  });

  // All invoices across merchants (pending/paid/expired), newest first, filterable.
  app.get("/api/admin/invoices", requireAdmin, async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (status && !VALID_STATUS.includes(status as InvoiceStatus)) {
      res.status(400).json({ error: `invalid status: ${status}` });
      return;
    }
    const merchantId = typeof req.query.merchantId === "string" ? req.query.merchantId : undefined;
    if (merchantId && !byId.has(merchantId)) {
      res.status(404).json({ error: `unknown merchant: ${merchantId}` });
      return;
    }
    res.json(
      (await store.listAll({ status: status as InvoiceStatus | undefined, merchantId })) as Invoice[]
    );
  });

  // Integration reference per merchant — the wiring an operator needs, with secrets,
  // behind auth. This is the reason /api/admin/* must never be exposed unauthenticated.
  app.get("/api/admin/merchants", requireAdmin, (req, res) => {
    const base = baseUrl(req);
    res.json(
      merchants.map((m) => ({
        id: m.id,
        name: m.name,
        apiKey: m.apiKey,
        webhookUrl: `${base}/webhook/${m.id}`,
        checkoutUrl: `${base}/checkout.html?merchant=${encodeURIComponent(m.id)}`,
        posCreateUrl: `${base}/api/pos/invoices`,
      }))
    );
  });
}

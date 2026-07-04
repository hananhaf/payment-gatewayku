import { test } from "node:test";
import assert from "node:assert";
import { adminEnabled, safeEqual, signSession, verifySession } from "./admin.ts";

const KEY = "s3cret-key";
const now = 1_700_000_000_000;

test("adminEnabled reflects ADMIN_PASSWORD presence", () => {
  assert.equal(adminEnabled({ ADMIN_PASSWORD: "pw" } as NodeJS.ProcessEnv), true);
  assert.equal(adminEnabled({ ADMIN_PASSWORD: "  " } as NodeJS.ProcessEnv), false);
  assert.equal(adminEnabled({} as NodeJS.ProcessEnv), false);
});

test("safeEqual is true only for identical strings", () => {
  assert.equal(safeEqual("hunter2", "hunter2"), true);
  assert.equal(safeEqual("hunter2", "hunter3"), false);
  assert.equal(safeEqual("short", "a-much-longer-value"), false); // length differs, no throw
});

test("a freshly signed session verifies", () => {
  const token = signSession(now + 60_000, KEY);
  assert.equal(verifySession(token, KEY, now), true);
});

test("expired session is rejected", () => {
  const token = signSession(now - 1, KEY);
  assert.equal(verifySession(token, KEY, now), false);
});

test("tampered signature is rejected", () => {
  const token = signSession(now + 60_000, KEY);
  const bad = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
  assert.equal(verifySession(bad, KEY, now), false);
});

test("extending expiry without re-signing is rejected", () => {
  const token = signSession(now + 1000, KEY);
  const [, mac] = token.split(".");
  const forged = `${now + 9_999_999}.${mac}`;
  assert.equal(verifySession(forged, KEY, now), false);
});

test("wrong key is rejected", () => {
  const token = signSession(now + 60_000, KEY);
  assert.equal(verifySession(token, "other-key", now), false);
});

test("malformed tokens are rejected, not thrown", () => {
  for (const t of ["", "no-dot", ".", "abc.def", `${now + 1000}.`]) {
    assert.equal(verifySession(t, KEY, now), false);
  }
});

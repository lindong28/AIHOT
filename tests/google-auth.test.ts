import "./setup.ts";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { after, test } from "node:test";
import Fastify from "fastify";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

process.env.GOOGLE_CLIENT_ID = "offline-google-client";
process.env.GOOGLE_CLIENT_SECRET = "offline-google-secret";
const { config } = await import("@aihot/backend/config");
config.googleAdminEmails = ["radar-test@gmail.com"];
config.allowPrivateNetworkFetch = true;
config.egressProxyUrl = null;
config.siteUrl = "https://radar.example";
config.adminPassword = "offline-admin-password";
config.devAdmin = null;
const { sql, closeDb } = await import("@aihot/backend/db");
const { registerAdminAuth, adminHandler } = await import("../apps/api/src/routes/admin-auth.ts");
const { googleLoginRedirect } = await import("@aihot/backend/admin/google-auth");

const original = getGlobalDispatcher();
const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...key.publicKey.export({ format: "jwk" }), kid: "offline", alg: "RS256", use: "sig" };
mock.get("https://www.googleapis.com").intercept({ path: "/oauth2/v3/certs" }).reply(200, { keys: [jwk] }).persist();
const app = Fastify({ logger: false });
registerAdminAuth(app);
app.post("/api/admin/guard-test", adminHandler(async () => ({ ok: true })));
after(async () => { await app.close(); setGlobalDispatcher(original); await mock.close(); await closeDb(); });

function jwt(nonce: string, overrides: Record<string, unknown> = {}, invalidSignature = false) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const text = `${encode({ alg: "RS256", kid: "offline" })}.${encode({
    iss: "https://accounts.google.com", aud: "offline-google-client", sub: "offline-subject", iat: now, exp: now + 3600,
    email: "radar-test@gmail.com", email_verified: true, name: "Radar Test", nonce, ...overrides,
  })}`;
  return `${text}.${sign("RSA-SHA256", Buffer.from(text), invalidSignature ? wrongKey.privateKey : key.privateKey).toString("base64url")}`;
}
function cookieHeader(response: { headers: Record<string, unknown> }) {
  const values = response.headers["set-cookie"];
  return (Array.isArray(values) ? values : [values]).filter(Boolean).map(v => String(v).split(";")[0]).join("; ");
}
async function begin(returnTo = "/admin/sources", code = "offline-code") {
  // Direct builder avoids consuming the public start limiter in the identity rejection matrix.
  const start = await googleLoginRedirect(returnTo);
  const url = new URL(start.url);
  return { url, cookie: `aihot_google_state=${start.stateCookie}`, callback: `/api/auth/google/callback?${new URLSearchParams({ code, state: url.searchParams.get("state")! })}` };
}
function tokenReply(start: Awaited<ReturnType<typeof begin>>, overrides: Record<string, unknown> = {}, invalidSignature = false) {
  const code = new URL(start.callback, config.siteUrl).searchParams.get("code");
  mock.get("https://oauth2.googleapis.com").intercept({ path: "/token", method: "POST", body: body => new URLSearchParams(String(body)).get("code") === code }).reply(options => {
    const body = new URLSearchParams(String(options.body));
    assert.equal(body.get("client_id"), "offline-google-client");
    assert.equal(body.get("client_secret"), "offline-google-secret");
    assert.equal(body.get("redirect_uri"), "https://radar.example/api/auth/google/callback");
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), start.url.searchParams.get("code_challenge"));
    return { statusCode: 200, data: { access_token: "offline-access", token_type: "Bearer", expires_in: 3600, id_token: jwt(start.url.searchParams.get("nonce")!, overrides, invalidSignature) }, responseOptions: { headers: { "content-type": "application/json" } } };
  });
}

test("Google authentication, authorization, replay protection and existing sessions", async t => {
  await sql`DELETE FROM admin_sessions`;
  await sql`DELETE FROM admin_users WHERE email LIKE 'radar-%@gmail.com' OR google_sub LIKE 'offline-%'`;
  await sql`DELETE FROM admin_google_login_attempts`;
  let session = "";
  await t.test("configured options, secure initiation and successful callback to the requested admin page", async () => {
    assert.equal((await app.inject("/api/auth/options")).json().google, true);
    const response = await app.inject("/api/auth/google?return=%2Fadmin%2Fsources");
    assert.equal(response.statusCode, 302);
    assert.match(String(response.headers["set-cookie"]), /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
    const url = new URL(response.headers.location!);
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.searchParams.get("scope"), "openid email profile");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const start = { url, cookie: cookieHeader(response), callback: `/api/auth/google/callback?code=offline-code&state=${url.searchParams.get("state")}` };
    tokenReply(start);
    const completed = await app.inject({ url: start.callback, headers: { cookie: start.cookie } });
    assert.equal(completed.statusCode, 303);
    assert.equal(completed.headers.location, "/admin/sources");
    session = cookieHeader(completed);
    const me = await app.inject({ url: "/api/admin/me", headers: { cookie: session } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().name, "Radar Test");
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/guard-test", headers: { cookie: session } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/guard-test", headers: { cookie: session, "x-csrf-token": me.json().csrf } })).statusCode, 200);
    assert.equal((await app.inject({ url: start.callback, headers: { cookie: start.cookie } })).headers.location, "/admin/login?return=%2Fadmin&error=google-state");
  });
  await t.test("revocation uses login-time Google email, while legacy password login stays available", async () => {
    await sql`UPDATE admin_users SET email='radar-changed@gmail.com' WHERE google_sub='offline-subject'`;
    assert.equal((await app.inject({ url: "/api/auth/check", headers: { cookie: session } })).statusCode, 204);
    config.googleAdminEmails = [];
    assert.equal((await app.inject({ url: "/api/auth/check", headers: { cookie: session } })).statusCode, 401);
    assert.equal((await app.inject("/api/auth/options")).json().google, false);
    assert.match((await app.inject("/api/auth/google")).headers.location!, /google-unavailable/);
    const password = await app.inject({ method: "POST", url: "/api/auth/password", payload: { password: config.adminPassword } });
    assert.equal((await app.inject({ url: "/api/auth/check", headers: { cookie: cookieHeader(password) } })).statusCode, 204);
    config.googleAdminEmails = ["radar-test@gmail.com"];
    await sql`UPDATE admin_users SET email='radar-test@gmail.com' WHERE google_sub='offline-subject'`;
  });
  await t.test("accepts Google's bare-domain issuer with a valid signature", async () => {
    const start = await begin(); tokenReply(start, { iss: "accounts.google.com" });
    const response = await app.inject({ url: start.callback, headers: { cookie: start.cookie } });
    assert.equal(response.headers.location, "/admin/sources");
    assert.equal((await app.inject({ url: "/api/auth/check", headers: { cookie: cookieHeader(response) } })).statusCode, 204);
  });
  await t.test("wrong browser does not consume the transaction; cancellation consumes it without a token request", async () => {
    const start = await begin();
    const wrong = await app.inject({ url: start.callback, headers: { cookie: "aihot_google_state=wrong" } });
    assert.match(wrong.headers.location!, /google-state/);
    const cancelled = await app.inject({ url: start.callback + "&error=access_denied", headers: { cookie: start.cookie } });
    assert.match(cancelled.headers.location!, /google-cancelled/);
    assert.match(String(cancelled.headers["set-cookie"]), /Max-Age=0/);
    assert.match((await app.inject({ url: start.callback, headers: { cookie: start.cookie } })).headers.location!, /google-state/);
  });
  await t.test("expired transactions and invalid return paths", async () => {
    const start = await begin("//evil.example/admin");
    const [row] = await sql`SELECT return_to FROM admin_google_login_attempts WHERE state_hash=${createHash("sha256").update(start.url.searchParams.get("state")!).digest("hex")}`;
    assert.equal(row!.return_to, "/admin");
    await sql`UPDATE admin_google_login_attempts SET expires_at=now()-interval '1 second'`;
    assert.match((await app.inject({ url: start.callback, headers: { cookie: start.cookie } })).headers.location!, /google-state/);
    await begin();
    assert.equal(Number((await sql`SELECT count(*) FROM admin_google_login_attempts WHERE expires_at <= now()`)[0]!.count), 0);
  });
  for (const [label, overrides, badSignature] of [
    ["unlisted email", { email: "radar-other@gmail.com" }, false],
    ["unverified email", { email_verified: false }, false],
    ["wrong audience", { aud: "other-client" }, false],
    ["wrong issuer", { iss: "https://evil.example" }, false],
    ["wrong nonce", { nonce: "wrong" }, false],
    ["expired token", { exp: 1 }, false],
    ["invalid signature", {}, true],
    ["bare-domain issuer with an invalid signature", { iss: "accounts.google.com" }, true],
    ["another subject for the same email", { sub: "offline-attacker" }, false],
  ] as const) await t.test(`rejects ${label} without issuing a session`, async () => {
    const start = await begin(); tokenReply(start, overrides, badSignature);
    const response = await app.inject({ url: start.callback, headers: { cookie: start.cookie } });
    assert.match(response.headers.location!, /error=google-(denied|failed)/);
    assert.doesNotMatch(cookieHeader(response), /aihot_admin=/);
  });
  await t.test("parallel callbacks consume exactly one transaction", async () => {
    const start = await begin(); tokenReply(start);
    const results = await Promise.all([1, 2].map(() => app.inject({ url: start.callback, headers: { cookie: start.cookie } })));
    assert.equal(results.filter(r => r.headers.location === "/admin/sources").length, 1);
    assert.equal(results.filter(r => r.headers.location?.includes("google-state")).length, 1);
  });
  await t.test("different subjects racing to bind the same email cannot replace the winner", async () => {
    config.googleAdminEmails.push("radar-race@gmail.com");
    const starts = await Promise.all(["a", "b"].map(id => begin("/admin/sources", `race-${id}`)));
    starts.forEach((start, index) => tokenReply(start, { email: "radar-race@gmail.com", sub: `offline-race-${index}` }));
    const results = await Promise.all(starts.map(start => app.inject({ url: start.callback, headers: { cookie: start.cookie } })));
    assert.equal(results.filter(r => r.headers.location === "/admin/sources").length, 1);
    assert.equal(results.filter(r => r.headers.location?.includes("google-denied")).length, 1);
    const [user] = await sql`SELECT id, google_sub FROM admin_users WHERE email='radar-race@gmail.com'`;
    assert.equal(user!.google_sub, `offline-race-${results.findIndex(r => r.headers.location === "/admin/sources")}`);
    assert.equal(Number((await sql`SELECT count(*) FROM admin_sessions WHERE user_id=${user!.id}`)[0]!.count), 1);
  });
  await t.test("per-client start rate limit and logout", async () => {
    for (let i = 0; i < 10; i++) await app.inject({ url: "/api/auth/google", remoteAddress: "192.0.2.42" });
    assert.match((await app.inject({ url: "/api/auth/google", remoteAddress: "192.0.2.42" })).headers.location!, /too-many/);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: session } });
    assert.equal((await app.inject({ url: "/api/auth/check", headers: { cookie: session } })).statusCode, 401);
    mock.assertNoPendingInterceptors();
  });
});

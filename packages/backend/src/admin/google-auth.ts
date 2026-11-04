// Google OIDC uses the existing admin session. Provider tokens never leave this module or get stored.
import { randomBytes } from "node:crypto";
import * as oidc from "oauth4webapi";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { sha256 } from "../lib/ids.ts";
import { audit, createSession, LoginRejected, safeReturn } from "./auth.ts";

export const GOOGLE_STATE_COOKIE = "aihot_google_state";
export const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";
const callbackUrl = () => `${config.siteUrl}${GOOGLE_CALLBACK_PATH}`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export function googleLoginConfigured(): boolean {
  return !!credential("auth", "GOOGLE_CLIENT_ID") && !!credential("auth", "GOOGLE_CLIENT_SECRET") && config.googleAdminEmails.length > 0;
}

const server: oidc.AuthorizationServer = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: TOKEN_URL,
  jwks_uri: JWKS_URL,
  id_token_signing_alg_values_supported: ["RS256"],
};
const bareIssuerServer: oidc.AuthorizationServer = { ...server, issuer: "accounts.google.com" };
const jwksCache: oidc.JWKSCacheInput = {};
const transport = {
  [oidc.jwksCache]: jwksCache,
  [oidc.customFetch]: async (url: string, options: oidc.CustomFetchOptions<string, unknown>) => {
    // No discovery or redirects: credentials only travel to the fixed Google token endpoint.
    if (url !== TOKEN_URL && url !== JWKS_URL) throw new Error("Unexpected Google endpoint");
    const response = await guardedFetch(url, {
      method: options.method, headers: options.headers,
      body: options.body == null ? undefined : String(options.body),
      route: "egress", timeoutMs: 15_000, maxBytes: 256 * 1024, maxRedirects: 0,
    });
    return new Response(new Uint8Array(response.body), { status: response.status, headers: response.headers });
  },
};

export async function googleLoginRedirect(returnTo: string) {
  if (!googleLoginConfigured()) throw new LoginRejected("google-unavailable");
  const state = oidc.generateRandomState();
  const browser = randomBytes(32).toString("base64url");
  const verifier = oidc.generateRandomCodeVerifier();
  const nonce = oidc.generateRandomNonce();
  await sql`DELETE FROM admin_google_login_attempts WHERE expires_at <= now()`;
  await sql`INSERT INTO admin_google_login_attempts (state_hash, browser_hash, code_verifier, nonce, return_to, expires_at)
    VALUES (${sha256(state)}, ${sha256(browser)}, ${verifier}, ${nonce}, ${safeReturn(returnTo)}, now() + interval '10 minutes')`;
  const url = new URL(server.authorization_endpoint!);
  url.search = new URLSearchParams({
    client_id: credential("auth", "GOOGLE_CLIENT_ID")!,
    redirect_uri: callbackUrl(), scope: "openid email profile", response_type: "code",
    state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { url: url.href, stateCookie: browser };
}

export class GoogleLoginFailure extends Error {
  stage: string;
  errorCode: string;
  constructor(stage: string, errorCode: string) {
    super("Google sign-in failed");
    this.stage = stage;
    this.errorCode = errorCode;
  }
}

export async function completeGoogleLogin(query: URLSearchParams, browser: string | undefined, userAgent: string | undefined) {
  if (!googleLoginConfigured()) throw new LoginRejected("google-unavailable");
  const state = query.get("state");
  if (!state || !browser || query.getAll("state").length !== 1) throw new LoginRejected("google-state");
  const [attempt] = await sql<{ code_verifier: string; nonce: string; return_to: string }[]>`
    DELETE FROM admin_google_login_attempts WHERE state_hash = ${sha256(state)} AND browser_hash = ${sha256(browser)} AND expires_at > now()
    RETURNING code_verifier, nonce, return_to`;
  if (!attempt) throw new LoginRejected("google-state");
  if (query.has("error")) throw new LoginRejected("google-cancelled");
  let claims: oidc.IDToken;
  try {
    const client: oidc.Client = { client_id: credential("auth", "GOOGLE_CLIENT_ID")!, id_token_signed_response_alg: "RS256" };
    const parameters = oidc.validateAuthResponse(server, client, query, state);
    const response = await oidc.authorizationCodeGrantRequest(server, client,
      oidc.ClientSecretPost(credential("auth", "GOOGLE_CLIENT_SECRET")!), parameters, callbackUrl(), attempt.code_verifier, transport);
    // Google documents two issuer spellings. Unverified data only chooses a fixed candidate;
    // all claims and the original JWT signature must still pass the SDK's validation below.
    let issuerServer = server;
    if (response.ok) {
      const body = await response.clone().json() as { id_token?: unknown };
      if (typeof body.id_token === "string") {
        const payload = JSON.parse(Buffer.from(body.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { iss?: unknown };
        if (payload.iss === bareIssuerServer.issuer) issuerServer = bareIssuerServer;
      }
    }
    const tokens = await oidc.processAuthorizationCodeResponse(issuerServer, client, response, {
      expectedNonce: attempt.nonce, requireIdToken: true,
    });
    await oidc.validateApplicationLevelSignature(issuerServer, response, transport);
    claims = oidc.getValidatedIdTokenClaims(tokens)!;
  } catch (error) {
    // The SDK cause may contain authorization codes, token responses or request bodies.
    const code = error instanceof oidc.OperationProcessingError ? error.code ?? "oidc_error" : "transport_error";
    throw new GoogleLoginFailure("identity_verification", code);
  }
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  // Google is authoritative for Gmail and verified Workspace addresses, not arbitrary external mail.
  const authoritative = email.endsWith("@gmail.com") || (typeof claims.hd === "string" && claims.hd.length > 0);
  if (claims.email_verified !== true || !authoritative || !config.googleAdminEmails.includes(email)) throw new LoginRejected("google-denied");
  const name = typeof claims.name === "string" ? claims.name.slice(0, 200) : email;
  // A known subject stays the same identity even if its allowlisted email changes.
  const [known] = await sql<{ id: number }[]>`UPDATE admin_users SET display_name = ${name}, last_login_at = now() WHERE google_sub = ${claims.sub} RETURNING id`;
  const [user] = known ? [known] : await sql<{ id: number }[]>`
    INSERT INTO admin_users (google_sub, email, display_name, last_login_at) VALUES (${claims.sub}, ${email}, ${name}, now())
    ON CONFLICT (email) DO UPDATE SET google_sub = EXCLUDED.google_sub, display_name = EXCLUDED.display_name, last_login_at = now()
    WHERE admin_users.google_sub IS NULL OR admin_users.google_sub = EXCLUDED.google_sub RETURNING id`;
  if (!user) throw new LoginRejected("google-denied");
  const token = await createSession(user.id, userAgent, email);
  await audit(`admin:${user.id}`, "auth.login", null, null, null, { method: "google" });
  return { token, returnTo: attempt.return_to, userId: user.id };
}

import { SignJWT, jwtVerify } from "jose";
import { OAuth2Client } from "google-auth-library";

export type JWTPayload = { sub: string; email: string; name: string };

type OAuthClient = { client_id: string; client_secret: string; redirect_uris: string[] };
type PendingAuth = {
  client_id: string;
  redirect_uri: string;
  mcpState?: string;
  mcpCodeChallenge: string;
  googleCodeVerifier: string;
};
type AuthCode = {
  client_id: string;
  redirect_uri: string;
  mcpCodeChallenge: string;
  sub: string;
  email: string;
  name: string;
  expires_at: number;
};

export const clients = new Map<string, OAuthClient>();
export const pendingAuths = new Map<string, PendingAuth>();
export const authCodes = new Map<string, AuthCode>();

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const jwtSecret = new TextEncoder().encode(process.env.JWT_SECRET!);
const SERVER_URL = process.env.SERVER_URL!;

// --- PKCE ---

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return { verifier, challenge };
}

export async function verifyPKCE(verifier: string, challenge: string): Promise<boolean> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const computed = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return computed === challenge;
}

// --- Google ---

export async function exchangeAndVerifyGoogleCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ sub: string; email: string; name: string }> {
  const params = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token exchange failed: ${err}`);
  }

  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("Google did not return an id_token");

  const ticket = await googleClient.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID!,
  });

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email || !payload.name) {
    throw new Error("Google ID token missing required claims");
  }

  return { sub: payload.sub, email: payload.email, name: payload.name };
}

// --- JWT ---

export async function signAccessToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ ...payload, typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SERVER_URL)
    .setAudience(`${SERVER_URL}/mcp`)
    .setExpirationTime("1h")
    .setIssuedAt()
    .sign(jwtSecret);
}

export async function signRefreshToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ ...payload, typ: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SERVER_URL)
    .setAudience(`${SERVER_URL}/token`)
    .setExpirationTime("30d")
    .setIssuedAt()
    .sign(jwtSecret);
}

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, jwtSecret, {
    issuer: SERVER_URL,
    audience: `${SERVER_URL}/mcp`,
  });
  if (payload["typ"] !== "access") throw new Error("Wrong token type");
  const { sub, email, name } = payload as Record<string, unknown>;
  if (typeof sub !== "string" || typeof email !== "string" || typeof name !== "string") {
    throw new Error("Missing claims");
  }
  return { sub, email, name };
}

export async function verifyRefreshToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, jwtSecret, {
    issuer: SERVER_URL,
    audience: `${SERVER_URL}/token`,
  });
  if (payload["typ"] !== "refresh") throw new Error("Wrong token type");
  const { sub, email, name } = payload as Record<string, unknown>;
  if (typeof sub !== "string" || typeof email !== "string" || typeof name !== "string") {
    throw new Error("Missing claims");
  }
  return { sub, email, name };
}

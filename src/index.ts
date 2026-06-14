import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import {
  type JWTPayload,
  clients,
  pendingAuths,
  authCodes,
  generatePKCE,
  verifyPKCE,
  exchangeAndVerifyGoogleCode,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "./auth.js";
import { createServer } from "./tools.js";

const PORT = Number(process.env.PORT ?? 3000);
const SERVER_URL = process.env.SERVER_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

if (!SERVER_URL) throw new Error("SERVER_URL is not set");
if (!GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID is not set");
if (!process.env.GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_SECRET is not set");
if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is not set");

const DEBUG = process.env.DEBUG === "true";
const SESSION_IDLE_MS = 30 * 60 * 1000;

type Session = {
  transport: WebStandardStreamableHTTPServerTransport;
  timer: ReturnType<typeof setTimeout>;
};

const sessions = new Map<string, Session>();

function touchSession(sid: string) {
  const session = sessions.get(sid);
  if (!session) return;
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    sessions.delete(sid);
    console.log(`[session] expired ${sid} (total: ${sessions.size})`);
  }, SESSION_IDLE_MS);
}

type Variables = { user: JWTPayload };
const app = new Hono<{ Variables: Variables }>();

// --- Health ---

app.get("/health", (c) => c.json({ status: "ok" }));

// --- OAuth Discovery ---

app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: `${SERVER_URL}/mcp`,
    authorization_servers: [SERVER_URL],
    resource_name: "calendly-booking-mcp",
  }),
);

app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: SERVER_URL,
    authorization_endpoint: `${SERVER_URL}/authorize`,
    token_endpoint: `${SERVER_URL}/token`,
    registration_endpoint: `${SERVER_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["openid", "profile", "email"],
  }),
);

// --- Dynamic Client Registration (RFC 7591) ---

app.post("/register", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const client_id = crypto.randomUUID();
  const client_secret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const redirect_uris = Array.isArray(body["redirect_uris"])
    ? (body["redirect_uris"] as string[])
    : [];
  clients.set(client_id, { client_id, client_secret, redirect_uris });
  return c.json(
    {
      client_id,
      client_secret,
      redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201,
  );
});

// --- Authorization Endpoint ---

app.get("/authorize", async (c) => {
  const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state } =
    c.req.query();

  if (!client_id || !clients.has(client_id)) return c.text("Unknown client_id", 400);
  if (response_type !== "code") return c.text("Only response_type=code is supported", 400);
  if (code_challenge_method !== "S256")
    return c.text("Only S256 code_challenge_method is supported", 400);
  if (!code_challenge) return c.text("code_challenge is required", 400);
  if (!redirect_uri) return c.text("redirect_uri is required", 400);

  const { verifier: googleCodeVerifier, challenge: googleCodeChallenge } = await generatePKCE();
  const googleState = crypto.randomUUID();

  pendingAuths.set(googleState, {
    client_id,
    redirect_uri,
    mcpState: state,
    mcpCodeChallenge: code_challenge,
    googleCodeVerifier,
  });

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${SERVER_URL}/auth/callback`,
    response_type: "code",
    scope: "openid profile email",
    access_type: "offline",
    prompt: "consent",
    code_challenge: googleCodeChallenge,
    code_challenge_method: "S256",
    state: googleState,
  });

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// --- Google OAuth Callback ---

app.get("/auth/callback", async (c) => {
  const { code, state, error } = c.req.query();

  if (error) return c.text(`Google auth error: ${error}`, 400);

  const pending = pendingAuths.get(state ?? "");
  if (!pending) return c.text("Invalid or expired state", 400);
  pendingAuths.delete(state!);

  try {
    const profile = await exchangeAndVerifyGoogleCode(
      code!,
      `${SERVER_URL}/auth/callback`,
      pending.googleCodeVerifier,
    );

    const authCode = crypto.randomUUID();
    authCodes.set(authCode, {
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      mcpCodeChallenge: pending.mcpCodeChallenge,
      sub: profile.sub,
      email: profile.email,
      name: profile.name,
      expires_at: Date.now() + 5 * 60 * 1000,
    });

    const callbackParams = new URLSearchParams({ code: authCode });
    if (pending.mcpState) callbackParams.set("state", pending.mcpState);
    return c.redirect(`${pending.redirect_uri}?${callbackParams.toString()}`);
  } catch (err) {
    console.error("[auth/callback] error:", err);
    return c.text("Authentication failed", 500);
  }
});

// --- Token Endpoint ---

app.post("/token", async (c) => {
  const body = (await c.req.parseBody()) as Record<string, string>;
  const grantType = body["grant_type"];

  if (grantType === "authorization_code") {
    const { code, code_verifier } = body;
    const authCode = authCodes.get(code ?? "");

    if (!authCode)
      return c.json({ error: "invalid_grant", error_description: "Unknown or expired code" }, 400);
    if (Date.now() > authCode.expires_at) {
      authCodes.delete(code!);
      return c.json({ error: "invalid_grant", error_description: "Code expired" }, 400);
    }

    const valid = await verifyPKCE(code_verifier ?? "", authCode.mcpCodeChallenge);
    if (!valid)
      return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);

    authCodes.delete(code!);

    const payload: JWTPayload = { sub: authCode.sub, email: authCode.email, name: authCode.name };
    return c.json({
      access_token: await signAccessToken(payload),
      refresh_token: await signRefreshToken(payload),
      token_type: "bearer",
      expires_in: 3600,
    });
  }

  if (grantType === "refresh_token") {
    const { refresh_token } = body;
    try {
      const payload = await verifyRefreshToken(refresh_token ?? "");
      return c.json({
        access_token: await signAccessToken(payload),
        token_type: "bearer",
        expires_in: 3600,
      });
    } catch {
      return c.json(
        { error: "invalid_grant", error_description: "Invalid or expired refresh token" },
        401,
      );
    }
  }

  return c.json({ error: "unsupported_grant_type" }, 400);
});

// --- Auth Middleware + MCP Endpoint ---

app.use("/mcp", async (c, next) => {
  const token = c.req.header("authorization")?.replace(/^Bearer /i, "");
  if (!token) {
    return c.json({ error: "invalid_token" }, 401, {
      "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${SERVER_URL}/.well-known/oauth-protected-resource"`,
    });
  }
  try {
    const user = await verifyAccessToken(token);
    if (DEBUG) console.log("[auth] verified user:", user);
    c.set("user", user);
    await next();
  } catch {
    return c.json({ error: "invalid_token" }, 401, {
      "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${SERVER_URL}/.well-known/oauth-protected-resource"`,
    });
  }
});

app.all("/mcp", async (c) => {
  try {
    const req = c.req.raw;
    const sessionId = req.headers.get("mcp-session-id");

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return c.text("Session not found", 404);
      touchSession(sessionId);
      return session.transport.handleRequest(req);
    }

    if (req.method !== "POST") {
      return c.text("Method Not Allowed", 405);
    }

    const user = c.get("user");
    const server = createServer(user);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        const timer = setTimeout(() => {
          sessions.delete(sid);
          console.log(`[session] expired ${sid} (total: ${sessions.size})`);
        }, SESSION_IDLE_MS);
        sessions.set(sid, { transport, timer });
        console.log(`[session] created ${sid} (total: ${sessions.size})`);
      },
      onsessionclosed: (sid) => {
        const session = sessions.get(sid);
        if (session) clearTimeout(session.timer);
        sessions.delete(sid);
        console.log(`[session] closed ${sid} (total: ${sessions.size})`);
      },
    });

    await server.connect(transport);
    return transport.handleRequest(req);
  } catch (err) {
    console.error("[fetch] unhandled error:", err);
    return c.text("Internal Server Error", 500);
  }
});

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  fetch: app.fetch,
});

console.log(`calendly-booking-mcp listening on ${SERVER_URL}/mcp`);

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Who may use the hosted app, without user accounts:
//
// - ADMIN_PASSWORD signs you in as admin: everything, including lock marks.
// - VIEWER_PASSWORD signs league mates in as viewers: everything except
//   changing lock marks.
//
// A sign-in sets a signed cookie (HMAC with SESSION_SECRET) that lasts 30
// days. With no ADMIN_PASSWORD set (local development), there is no sign-in
// and everyone is admin.

export type Role = "admin" | "viewer";

export interface AuthConfig {
  adminPassword: string | null;
  viewerPassword: string | null;
  secret: string;
}

export const SESSION_COOKIE = "ft_session";
const SESSION_DAYS = 30;

export function authFromEnv(env: NodeJS.ProcessEnv): AuthConfig | null {
  const adminPassword = env.ADMIN_PASSWORD?.trim() || null;
  if (!adminPassword) return null;
  let secret = env.SESSION_SECRET?.trim();
  if (!secret) {
    // Sessions then last only until the next restart.
    console.warn("[auth] SESSION_SECRET is not set; everyone is signed out when the server restarts.");
    secret = randomBytes(32).toString("hex");
  }
  return { adminPassword, viewerPassword: env.VIEWER_PASSWORD?.trim() || null, secret };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Compares in constant time, so the answer time does not hint at the password. */
function samePassword(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** The role a password signs in as, or null. The admin password wins if both match. */
export function roleForPassword(config: AuthConfig, password: string): Role | null {
  if (config.adminPassword && samePassword(password, config.adminPassword)) return "admin";
  if (config.viewerPassword && samePassword(password, config.viewerPassword)) return "viewer";
  return null;
}

const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export function createSessionToken(role: Role, secret: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ role, exp: now + SESSION_DAYS * 86_400_000 })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** The role in a valid, unexpired token, or null. */
export function readSessionToken(token: string | undefined, secret: string, now = Date.now()): Role | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: unknown; exp?: unknown };
    if (typeof data.exp !== "number" || data.exp < now) return null;
    return data.role === "admin" || data.role === "viewer" ? data.role : null;
  } catch {
    return null;
  }
}

/** A cookie's value from the request, without a cookie library. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_DAYS * 86_400}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export const clearedCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/** At most `limit` sign-in attempts per address in each window. */
export function createAttemptLimiter(limit = 10, windowMs = 15 * 60_000, now = () => Date.now()) {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return (address: string): boolean => {
    const time = now();
    const entry = attempts.get(address);
    if (!entry || entry.resetAt <= time) {
      attempts.set(address, { count: 1, resetAt: time + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= limit;
  };
}

/** The signed-in role, or admin when sign-in is off. */
export function roleOf(config: AuthConfig | null, request: Request): Role | null {
  if (!config) return "admin";
  return readSessionToken(readCookie(request.headers.cookie, SESSION_COOKIE), config.secret);
}

/** Lets a request through only with the given role (or any role when none is given). */
export function requireRole(config: AuthConfig | null, needed?: Role) {
  return (request: Request, response: Response, next: NextFunction) => {
    const role = roleOf(config, request);
    if (!role) {
      response.status(401).json({ error: "Sign in to use the app." });
      return;
    }
    if (needed === "admin" && role !== "admin") {
      response.status(403).json({ error: "Only the admin can change this." });
      return;
    }
    next();
  };
}

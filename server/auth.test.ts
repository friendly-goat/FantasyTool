import { describe, expect, it } from "vitest";
import {
  authFromEnv,
  createAttemptLimiter,
  createSessionToken,
  readCookie,
  readSessionToken,
  roleForPassword,
  sessionCookie,
} from "./auth.ts";

const config = { adminPassword: "admin-secret", viewerPassword: "league-mates", secret: "s".repeat(64) };

describe("auth", () => {
  it("is off without an admin password", () => {
    expect(authFromEnv({})).toBeNull();
    expect(authFromEnv({ ADMIN_PASSWORD: "x", VIEWER_PASSWORD: "y", SESSION_SECRET: "z" })).toEqual({
      adminPassword: "x",
      viewerPassword: "y",
      secret: "z",
    });
  });

  it("signs each password in as its role", () => {
    expect(roleForPassword(config, "admin-secret")).toBe("admin");
    expect(roleForPassword(config, "league-mates")).toBe("viewer");
    expect(roleForPassword(config, "wrong")).toBeNull();
    expect(roleForPassword({ ...config, viewerPassword: null }, "league-mates")).toBeNull();
    expect(roleForPassword({ ...config, viewerPassword: "admin-secret" }, "admin-secret")).toBe("admin");
  });

  it("issues tokens that only the secret can make, until they expire", () => {
    const token = createSessionToken("viewer", config.secret, 1000);
    expect(readSessionToken(token, config.secret, 2000)).toBe("viewer");
    expect(readSessionToken(token, "other-secret", 2000)).toBeNull();
    expect(readSessionToken(token, config.secret, 1000 + 31 * 86_400_000)).toBeNull();
    // A viewer cannot turn a token into an admin one without the secret.
    const [, signature] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ role: "admin", exp: 9e15 })).toString("base64url")}.${signature}`;
    expect(readSessionToken(forged, config.secret, 2000)).toBeNull();
    expect(readSessionToken(undefined, config.secret)).toBeNull();
    expect(readSessionToken("garbage", config.secret)).toBeNull();
  });

  it("reads and writes the cookie", () => {
    expect(readCookie("a=1; ft_session=abc.def; b=2", "ft_session")).toBe("abc.def");
    expect(readCookie(undefined, "ft_session")).toBeUndefined();
    expect(sessionCookie("t", true)).toContain("Secure");
    expect(sessionCookie("t", false)).not.toContain("Secure");
    expect(sessionCookie("t", false)).toContain("HttpOnly");
  });

  it("limits sign-in attempts per address", () => {
    let time = 0;
    const allow = createAttemptLimiter(3, 1000, () => time);
    expect([allow("a"), allow("a"), allow("a"), allow("a")]).toEqual([true, true, true, false]);
    expect(allow("b")).toBe(true);
    time = 1001;
    expect(allow("a")).toBe(true);
  });
});

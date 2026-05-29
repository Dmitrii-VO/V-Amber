import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuth } from "../server/auth.js";

function makeReq(headers = {}) {
  return { headers };
}

test("auth disabled when API_TOKEN is unset", () => {
  const auth = createAuth({});
  assert.equal(auth.enabled, false);
  // Any request passes — auth is effectively bypassed for HTTP.
  assert.equal(auth.isRequestAuthenticated(makeReq(), new URL("http://x/")), true);
  assert.equal(
    auth.isRequestAuthenticated(makeReq({ authorization: "Bearer anything" }), new URL("http://x/")),
    true,
  );
});

test("auth enabled when API_TOKEN is set", () => {
  const auth = createAuth({ API_TOKEN: "secret" });
  assert.equal(auth.enabled, true);
});

test("Bearer header authenticates with matching token", () => {
  const auth = createAuth({ API_TOKEN: "secret" });
  assert.equal(
    auth.isRequestAuthenticated(makeReq({ authorization: "Bearer secret" }), new URL("http://x/")),
    true,
  );
});

test("Bearer header rejects mismatched token", () => {
  const auth = createAuth({ API_TOKEN: "secret" });
  assert.equal(
    auth.isRequestAuthenticated(makeReq({ authorization: "Bearer wrong" }), new URL("http://x/")),
    false,
  );
});

test("x-api-token header authenticates", () => {
  const auth = createAuth({ API_TOKEN: "secret" });
  assert.equal(
    auth.isRequestAuthenticated(makeReq({ "x-api-token": "secret" }), new URL("http://x/")),
    true,
  );
});

test("api_token cookie authenticates", () => {
  const auth = createAuth({ API_TOKEN: "secret" });
  assert.equal(
    auth.isRequestAuthenticated(
      makeReq({ cookie: "foo=bar; api_token=secret; other=v" }),
      new URL("http://x/"),
    ),
    true,
  );
});

test("URL-encoded cookie value authenticates", () => {
  const auth = createAuth({ API_TOKEN: "a/b+c" });
  assert.equal(
    auth.isRequestAuthenticated(
      makeReq({ cookie: `api_token=${encodeURIComponent("a/b+c")}` }),
      new URL("http://x/"),
    ),
    true,
  );
});

test("malformed cookie value is ignored without throwing", () => {
  const auth = createAuth({ API_TOKEN: "secret" });
  assert.equal(
    auth.isRequestAuthenticated(
      makeReq({ cookie: "api_token=%; other=value" }),
      new URL("http://x/"),
    ),
    false,
  );
});

test("query token authenticates", () => {
  const auth = createAuth({ API_TOKEN: "secret" });
  assert.equal(
    auth.isRequestAuthenticated(makeReq(), new URL("http://x/?token=secret")),
    true,
  );
});

test("token length mismatch returns false without throwing", () => {
  const auth = createAuth({ API_TOKEN: "secret" });
  // Different length triggers the early return in safeEqual — must not throw.
  assert.equal(
    auth.isRequestAuthenticated(makeReq({ "x-api-token": "s" }), new URL("http://x/")),
    false,
  );
  assert.equal(
    auth.isRequestAuthenticated(
      makeReq({ "x-api-token": "secret-and-more" }),
      new URL("http://x/"),
    ),
    false,
  );
});

test("Origin: missing header is allowed (non-browser clients)", () => {
  const auth = createAuth({ API_TOKEN: "secret" });
  assert.equal(auth.isOriginAllowed(undefined), true);
  assert.equal(auth.isOriginAllowed(""), true);
});

test("Origin: loopback hosts allowed by default", () => {
  const auth = createAuth({});
  assert.equal(auth.isOriginAllowed("http://localhost:8080"), true);
  assert.equal(auth.isOriginAllowed("http://127.0.0.1:8080"), true);
  assert.equal(auth.isOriginAllowed("http://localhost"), true);
});

test("Origin: foreign hosts rejected by default", () => {
  const auth = createAuth({});
  assert.equal(auth.isOriginAllowed("https://evil.com"), false);
  assert.equal(auth.isOriginAllowed("http://192.168.1.10"), false);
});

test("Origin: malformed origin rejected by default", () => {
  const auth = createAuth({});
  assert.equal(auth.isOriginAllowed("not a url"), false);
});

test("ALLOWED_ORIGINS replaces loopback default", () => {
  const auth = createAuth({ ALLOWED_ORIGINS: "https://app.example.com" });
  assert.equal(auth.isOriginAllowed("https://app.example.com"), true);
  // Loopback is NO LONGER allowed when an explicit list is set.
  assert.equal(auth.isOriginAllowed("http://localhost:8080"), false);
});

test("ALLOWED_ORIGINS supports CSV list with spaces", () => {
  const auth = createAuth({ ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com" });
  assert.equal(auth.isOriginAllowed("https://a.example.com"), true);
  assert.equal(auth.isOriginAllowed("https://b.example.com"), true);
  assert.equal(auth.isOriginAllowed("https://c.example.com"), false);
});

test("setTokenCookie does nothing when auth is disabled", () => {
  const auth = createAuth({});
  let called = false;
  const fakeResp = { setHeader() { called = true; } };
  auth.setTokenCookie(fakeResp);
  assert.equal(called, false);
});

test("setTokenCookie sets HttpOnly SameSite=Lax cookie when enabled", () => {
  const auth = createAuth({ API_TOKEN: "secret" });
  let header = null;
  const fakeResp = {
    setHeader(name, value) {
      header = { name, value };
    },
  };
  auth.setTokenCookie(fakeResp);
  assert.equal(header.name, "set-cookie");
  assert.match(header.value, /^api_token=secret;/);
  assert.match(header.value, /HttpOnly/);
  assert.match(header.value, /SameSite=Lax/);
  assert.match(header.value, /Path=\//);
});

test("setTokenCookie URL-encodes special characters in token", () => {
  const auth = createAuth({ API_TOKEN: "a b+c/d" });
  let header = null;
  const fakeResp = {
    setHeader(name, value) {
      header = { name, value };
    },
  };
  auth.setTokenCookie(fakeResp);
  assert.match(header.value, new RegExp(`^api_token=${encodeURIComponent("a b+c/d")};`));
});

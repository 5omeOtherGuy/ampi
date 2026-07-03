import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-web URL policy", () => {
  it("accepts a normal public https URL", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    const result = validateExternalHttpUrl("https://example.com/path?q=1");
    assert.equal(result.ok, true);
    assert.equal(result.url.hostname, "example.com");
  });

  it("rejects empty or invalid input", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    assert.equal(validateExternalHttpUrl("").ok, false);
    assert.equal(validateExternalHttpUrl("not a url").ok, false);
  });

  it("rejects non-http(s) schemes", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/",
      "javascript:alert(1)",
      "data:text/plain,hello",
    ]) {
      const result = validateExternalHttpUrl(url);
      assert.equal(result.ok, false, `expected to reject ${url}`);
      assert.match(result.reason, /scheme/);
    }
  });

  it("rejects URLs with userinfo credentials", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    const result = validateExternalHttpUrl("https://user:pass@example.com/");
    assert.equal(result.ok, false);
    assert.match(result.reason, /credentials/i);
  });

  it("rejects localhost-style hostnames", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    for (const host of ["localhost", "ip6-localhost", "ip6-loopback", "service.local", "svc.localhost", "host.internal"]) {
      const result = validateExternalHttpUrl(`http://${host}/`);
      assert.equal(result.ok, false, `expected to reject ${host}`);
    }
  });

  it("rejects private and reserved IPv4 ranges", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    for (const ip of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.5",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
    ]) {
      const result = validateExternalHttpUrl(`http://${ip}/`);
      assert.equal(result.ok, false, `expected to reject ${ip}`);
    }
  });

  it("accepts a public IPv4 like 8.8.8.8", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    const result = validateExternalHttpUrl("http://8.8.8.8/");
    assert.equal(result.ok, true);
  });

  it("rejects loopback and link-local IPv6", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    for (const ip of ["[::1]", "[fc00::1]", "[fd12:3456:789a::1]", "[fe80::1]"]) {
      const result = validateExternalHttpUrl(`http://${ip}/`);
      assert.equal(result.ok, false, `expected to reject ${ip}`);
    }
  });

  it("rejects hostnames with a trailing dot (FQDN root) that match the local denylist", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    for (const url of [
      "http://localhost./",
      "http://LOCALHOST./",
      "http://ip6-localhost./",
      "http://service.local./",
      "http://svc.localhost./",
      "http://host.internal./",
    ]) {
      const result = validateExternalHttpUrl(url);
      assert.equal(result.ok, false, `expected to reject ${url}`);
    }
  });

  it("rejects IPv4-mapped IPv6 even when the URL parser normalizes to canonical hex form", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    // WHATWG URL normalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`.
    for (const url of [
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[::ffff:0a00:1]/", // 10.0.0.1
      "http://[::ffff:c0a8:1]/", // 192.168.0.1
    ]) {
      const result = validateExternalHttpUrl(url);
      assert.equal(result.ok, false, `expected to reject ${url}`);
    }
  });

  it("rejects NAT64 (64:ff9b::/96) addresses that embed private IPv4", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    for (const url of [
      "http://[64:ff9b::127.0.0.1]/",
      "http://[64:ff9b::7f00:1]/",
      "http://[64:ff9b::a00:1]/", // 10.0.0.1
    ]) {
      const result = validateExternalHttpUrl(url);
      assert.equal(result.ok, false, `expected to reject ${url}`);
    }
  });

  it("rejects IPv6 multicast (ff00::/8) and the unspecified address", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    for (const url of ["http://[::]/", "http://[ff02::1]/", "http://[ff00::1]/"]) {
      const result = validateExternalHttpUrl(url);
      assert.equal(result.ok, false, `expected to reject ${url}`);
    }
  });

  it("rejects non-default ports for http/https", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    for (const url of [
      "http://example.com:22/",
      "http://example.com:6379/",
      "https://example.com:8443/",
      "http://example.com:8080/",
      "https://example.com:81/",
    ]) {
      const result = validateExternalHttpUrl(url);
      assert.equal(result.ok, false, `expected to reject ${url}`);
      assert.match(result.reason, /port/i);
    }
  });

  it("accepts default ports (empty, 80 for http, 443 for https)", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    for (const url of [
      "http://example.com/",
      "https://example.com/",
      "http://example.com:80/",
      "https://example.com:443/",
    ]) {
      const result = validateExternalHttpUrl(url);
      assert.equal(result.ok, true, `expected to accept ${url}`);
    }
  });

  it("still accepts legitimate public IPv6 (e.g. 2606:4700:4700::1111)", async () => {
    const { validateExternalHttpUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    const result = validateExternalHttpUrl("http://[2606:4700:4700::1111]/");
    assert.equal(result.ok, true);
  });
});

describe("mmr-web SearXNG URL validation", () => {
  it("accepts loopback / private hosts because the URL is user-trusted", async () => {
    const { validateSearXNGUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    for (const url of [
      "http://127.0.0.1:8080",
      "http://localhost:8080",
      "http://10.0.0.5:8080",
      "http://searxng.local/",
      "https://searxng.example.com/",
    ]) {
      const result = validateSearXNGUrl(url);
      assert.equal(result.ok, true, `expected to accept ${url}, got ${JSON.stringify(result)}`);
    }
  });

  it("rejects non-http(s) schemes", async () => {
    const { validateSearXNGUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    for (const url of ["file:///tmp/sx", "javascript:alert(1)", "ftp://example.com/"]) {
      const result = validateSearXNGUrl(url);
      assert.equal(result.ok, false, `expected to reject ${url}`);
    }
  });

  it("rejects userinfo credentials", async () => {
    const { validateSearXNGUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    const result = validateSearXNGUrl("http://user:pass@127.0.0.1:8080");
    assert.equal(result.ok, false);
    assert.match(result.reason, /credentials/);
  });

  it("rejects empty / non-string input", async () => {
    const { validateSearXNGUrl } = await importSource("extensions/ampi-web/url-policy.ts");
    assert.equal(validateSearXNGUrl("").ok, false);
    assert.equal(validateSearXNGUrl("   ").ok, false);
    assert.equal(validateSearXNGUrl("not a url").ok, false);
  });
});

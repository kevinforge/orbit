import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSafeExternalUrl } from "../src/ui/url-guard.ts";

describe("isSafeExternalUrl", () => {
  it("allows https URLs", () => {
    assert.equal(isSafeExternalUrl("https://example.com"), true);
    assert.equal(isSafeExternalUrl("https://example.com/path?q=1"), true);
  });

  it("allows http URLs", () => {
    assert.equal(isSafeExternalUrl("http://example.com"), true);
    assert.equal(isSafeExternalUrl("http://localhost:3000/callback"), true);
  });

  it("rejects javascript: URLs", () => {
    assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  });

  it("rejects case-variant javascript: URLs", () => {
    assert.equal(isSafeExternalUrl("JaVaScRiPt:alert(1)"), false);
    assert.equal(isSafeExternalUrl("JavaScript:alert(1)"), false);
  });

  it("rejects data: URLs", () => {
    assert.equal(isSafeExternalUrl("data:text/html,<script>alert(1)</script>"), false);
  });

  it("rejects vbscript: URLs", () => {
    assert.equal(isSafeExternalUrl("vbscript:msgbox(1)"), false);
  });

  it("rejects empty string", () => {
    assert.equal(isSafeExternalUrl(""), false);
  });

  it("rejects relative URLs", () => {
    assert.equal(isSafeExternalUrl("/path/to/page"), false);
    assert.equal(isSafeExternalUrl("path/to/page"), false);
  });

  it("rejects mailto: and tel: (not browser-navigable external pages)", () => {
    assert.equal(isSafeExternalUrl("mailto:user@example.com"), false);
    assert.equal(isSafeExternalUrl("tel:+15551234"), false);
  });

  it("rejects file: URLs", () => {
    assert.equal(isSafeExternalUrl("file:///etc/passwd"), false);
  });
});

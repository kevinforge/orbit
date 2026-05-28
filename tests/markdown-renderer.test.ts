import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/ui/markdown-renderer.ts";

describe("renderMarkdown", () => {
  it("renders normal markdown as HTML", () => {
    const result = renderMarkdown("Hello **bold** and *italic*");
    assert.ok(result.includes("<strong>bold</strong>"));
    assert.ok(result.includes("<em>italic</em>"));
  });

  it("escapes raw script tags to prevent XSS", () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    assert.ok(!result.includes("<script>"));
    assert.ok(!result.includes("</script>"));
  });

  it("escapes HTML tags with event handlers", () => {
    const result = renderMarkdown('<img src="x" onerror="alert(1)">');
    assert.ok(!result.includes("<img"));
    assert.ok(result.includes("&lt;img"));
  });

  it("blocks javascript: URLs in links", () => {
    const result = renderMarkdown("[click](javascript:alert(1))");
    assert.ok(!result.includes("javascript:"));
  });

  it("allows safe href in links", () => {
    const result = renderMarkdown("[example](https://example.com)");
    assert.ok(result.includes('href="https://example.com"'));
  });

  it("escapes inline HTML tags", () => {
    const result = renderMarkdown('Text <b style="color:red">bold</b>');
    assert.ok(!result.includes("<b "));
  });

  it("escapes raw HTML inside link text", () => {
    const result = renderMarkdown("[<img src=x onerror=alert(1)>](https://example.com)");
    assert.ok(!result.includes("<img"), `expected no <img in: ${result}`);
    assert.ok(result.includes("&lt;img"), `expected escaped &lt;img in: ${result}`);
  });

  it("escapes href and src attribute values", () => {
    const result = renderMarkdown('[link](https://example.com/"onclick="alert(1))');
    assert.ok(!result.includes('"onclick'), `expected no unescaped quote-onclick in: ${result}`);
    assert.ok(result.includes("&quot;onclick"), `expected escaped quotes in: ${result}`);
  });
});

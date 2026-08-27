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

  it("renders unsafe hrefs as plain text without a dead empty link", () => {
    const result = renderMarkdown("[styles.css](ftp://example.com/x)");
    assert.ok(!result.includes("href="), `expected no href attribute in: ${result}`);
    assert.ok(result.includes("styles.css"), `expected link text kept as plain text in: ${result}`);
  });

  it("keeps plain text fallback for javascript: and data: hrefs", () => {
    for (const markdown of ["[x](javascript:alert(1))", "[x](data:text/html,<b>)"]) {
      const result = renderMarkdown(markdown);
      assert.ok(!result.includes("href="), `expected no href attribute in: ${result}`);
      assert.ok(result.includes(">x<"), `expected plain text fallback in: ${result}`);
    }
  });

  it("strips trailing CJK punctuation from autolink hrefs and keeps it as body text", () => {
    const result = renderMarkdown("详情见 https://example.com/a?b=1&c=2。");
    assert.ok(
      result.includes('href="https://example.com/a?b=1&amp;c=2"'),
      `expected clean href without the CJK period in: ${result}`,
    );
    assert.ok(result.includes("</a>。"), `expected the stripped period kept as body text in: ${result}`);
  });

  it("strips trailing CJK letters from autolink hrefs and keeps them as body text", () => {
    const result = renderMarkdown("看文档 https://github.com/kevinforge/orbit了解更多");
    assert.ok(
      result.includes('href="https://github.com/kevinforge/orbit"'),
      `expected clean href without CJK letters in: ${result}`,
    );
    assert.ok(result.includes("</a>了解更多"), `expected the stripped letters kept as body text in: ${result}`);
  });

  it("strips trailing CJK characters from explicit link hrefs but keeps the link text", () => {
    const result = renderMarkdown("[文本](https://example.com/x，)");
    assert.ok(result.includes('href="https://example.com/x"'), `expected clean href in: ${result}`);
    assert.ok(result.includes(">文本</a>，"), `expected link text and stripped comma in: ${result}`);
  });

  it("renders local drive hrefs as path entries instead of navigable links", () => {
    const result = renderMarkdown("[styles.css](D:/projects/orbit/src/ui/styles.css)");
    assert.ok(result.includes('data-path="D:/projects/orbit/src/ui/styles.css"'), `expected data-path entry in: ${result}`);
    assert.ok(result.includes('class="localPathLink"'), `expected entry class in: ${result}`);
    assert.ok(!result.includes("href="), `expected no href attribute in: ${result}`);
    assert.ok(result.includes(">styles.css</span>"), `expected link text kept in: ${result}`);
  });

  it("strips file:/// prefixes from local path entries", () => {
    const result = renderMarkdown("[查看](file:///D:/projects/orbit/src/ui/styles.css)");
    assert.ok(result.includes('data-path="D:/projects/orbit/src/ui/styles.css"'), `expected file:/// stripped in: ${result}`);
    assert.ok(!result.includes("file:"), `expected no file: scheme left in: ${result}`);
  });

  it("renders home-relative hrefs as path entries", () => {
    const result = renderMarkdown("[文档](~/notes/README.md)");
    assert.ok(result.includes('data-path="~/notes/README.md"'), `expected home-relative entry in: ${result}`);
  });

  it("recognizes bare Windows paths without swallowing adjacent CJK text", () => {
    const result = renderMarkdown("修改了 D:\\orbit\\src\\ui\\App.tsx。请复核");
    assert.ok(result.includes('data-path="D:\\orbit\\src\\ui\\App.tsx"'), `expected bare path entry in: ${result}`);
    assert.ok(result.includes("</span>。"), `expected the CJK period kept as body text in: ${result}`);
    assert.ok(result.includes("请复核"), `expected body text preserved in: ${result}`);
  });

  it("recognizes bare POSIX paths only with at least two segments", () => {
    const posix = renderMarkdown("位于 /usr/local/bin/node 目录");
    assert.ok(posix.includes('data-path="/usr/local/bin/node"'), `expected POSIX entry in: ${posix}`);
    const single = renderMarkdown("接口 /api 是单段");
    assert.ok(!single.includes("localPathLink"), `expected single-segment path untouched in: ${single}`);
  });

  it("does not treat slash-separated words as paths", () => {
    const result = renderMarkdown("tcp/ip 和 and/or 都是普通词");
    assert.ok(!result.includes("localPathLink"), `expected no path entry in: ${result}`);
  });

  it("keeps paths inside code spans as code", () => {
    const result = renderMarkdown("`D:/quoted/a.txt` 是代码");
    assert.ok(!result.includes("localPathLink"), `expected code span untouched in: ${result}`);
    assert.ok(result.includes("<code>D:/quoted/a.txt</code>"), `expected code span in: ${result}`);
  });

  it("escapes quotes in path entry attributes to prevent attribute injection", () => {
    const result = renderMarkdown('[x](D:/a"onmouseover="alert(1))');
    assert.ok(result.includes('data-path="D:/a&quot;onmouseover=&quot;alert(1)"'), `expected escaped data-path in: ${result}`);
    assert.ok(!result.includes('onmouseover="alert'), `expected no unescaped handler in: ${result}`);
  });
});

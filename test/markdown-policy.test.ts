import { describe, expect, test } from "bun:test";
import MarkdownIt from "markdown-it";
import {
  convertHtml,
  fencedCodeBlock,
  markdownLink,
  renderRichMarkdown,
  safeLink,
} from "../src/html";
import {
  DeepWikiCitation,
  LinkList,
  TweetContent,
  TweetThread,
  XTimelineTweet,
} from "../src/schemas";

describe("Markdown destination policy", () => {
  test("rejects active, encoded, malformed, credentialed, and ambiguous destinations", () => {
    for (const value of [
      "javascript:alert(1)",
      "  JaVaScRiPt:alert(1)  ",
      "javascript&colon;alert(1)",
      "&#x6a;avascript&#58;alert(1)",
      "&amp;#x6a;avascript&amp;colon;alert(1)",
      "data:text/html,x",
      "vbscript:msgbox(1)",
      "file:///tmp/private",
      "blob:https://example.test/id",
      "mailto:test@example.test",
      "custom:opaque",
      "%6a%61%76%61script:alert(1)",
      "%256a%2561vascript:alert(1)",
      "https://example.test/%0Ajavascript:x",
      "https://example.test/a b",
      "https://example.test/%zz",
      "https://user:pass@example.test/",
      "https://@example.test/",
      "https:%40example.test/",
      "//example.test/path",
      "&sol;&sol;example.test/path",
      "https://example.test/a\\b",
      "https://example.test/a\u200bb",
      "https://example.test/<x>",
    ])
      expect(safeLink(value)).toBeNull();
  });

  test("preserves safe relatives without a base and normalizes HTTP(S) with a safe base", () => {
    expect(safeLink("  /docs/a%2Fb?q=1#part  ")).toBe("/docs/a%2Fb?q=1#part");
    expect(safeLink("?q=ok")).toBe("?q=ok");
    expect(safeLink("#part")).toBe("#part");
    expect(safeLink("../a%2Fb", "https://EXAMPLE.test/docs/page")).toBe(
      "https://example.test/a%2Fb",
    );
    expect(safeLink("https://EXAMPLE.test/a%2Fb")).toBe("https://example.test/a%2Fb");
    expect(safeLink("/ok", "https://user@example.test/root")).toBeNull();
    expect(safeLink("/ok", "file:///tmp/base")).toBeNull();
    let unsettled = "javascript:alert(1)";
    for (let count = 0; count < 7; count += 1) unsettled = encodeURIComponent(unsettled);
    expect(safeLink(unsettled)).toBeNull();
    const normalized = safeLink("https://EXAMPLE.test/a%2Fb")!;
    expect(safeLink(normalized)).toBe(normalized);
  });

  test("escapes Markdown syntax, settles labels to one line, and rejects entity schemes", () => {
    expect(markdownLink("a[b]\\c\r\nnext", "https://example.test/a(b)")).toBe(
      "[a\\[b\\]\\\\c next](https://example.test/a\\(b\\))",
    );
    expect(markdownLink("a[b]\\c", "javascript&colon;x")).toBe("a\\[b\\]\\\\c");
    // Labels remain untrusted content; line folding prevents them from escaping renderer-owned syntax.
    expect(markdownLink("<b>raw</b>\nnext", "javascript:x")).toBe("<b>raw</b> next");
  });

  test("both HTML converters drop active elements and sanitize links and images", () => {
    const html = `<p><a href="jav&#x61;script:x">bad</a> <a href="/ok">ok</a>
      <img src="data&colon;text/html,x" alt="&lt;b&gt;raw&lt;/b&gt;\nnext">
      <img src="javascript:x"><script>drop</script><style>drop</style></p>`;
    for (const output of [convertHtml(html), renderRichMarkdown(html)]) {
      expect(output).toContain("bad");
      expect(output).not.toContain("javascript:");
      expect(output).toContain("[ok](/ok)");
      expect(output).toContain("&#60;b&#62;raw&#60;&#47;b&#62; next");
      expect(output).not.toContain("<b>raw</b>");
      expect(output).not.toContain("drop");
      expect(output).not.toContain("![");
    }
  });

  test("unsafe image alternatives remain plain CommonMark through nested fallbacks", () => {
    const html = `<p>
      <img src="javascript:image" alt="[click](javascript:link)">
      <img src="data:text/html,x" alt="![track](https://track.test/pixel)">
      <img src="file:///tmp/x" alt="[ref]\n[ref]: javascript:reference">
      <img src="blob:https://example.test/id" alt="&lt;javascript:autolink&gt;">
      <a href="javascript:outer"><img src="javascript:inner" alt="[nested](javascript:nested)"></a>
    </p>`;
    const parser = new MarkdownIt("commonmark");
    for (const output of [convertHtml(html), renderRichMarkdown(html)]) {
      const inlineTypes = parser
        .parse(output, {})
        .flatMap((token) => token.children ?? [])
        .map((token) => token.type);
      expect(inlineTypes).not.toContain("link_open");
      expect(inlineTypes).not.toContain("image");
      expect(inlineTypes).not.toContain("html_inline");
      expect(output).toContain("&#91;click&#93;&#40;javascript&#58;link&#41;");
      expect(output).toContain("&#33;&#91;track&#93;");
      expect(output).toContain("&#91;ref&#93; &#91;ref&#93;&#58; javascript&#58;reference");
      expect(output).toContain("&#60;javascript&#58;autolink&#62;");
      expect(output).toContain("&#91;nested&#93;&#40;javascript&#58;nested&#41;");
    }
  });

  test("preserves exact adaptive fences after sanitization", () => {
    for (const [run, fence] of [
      ["``", "```"],
      ["```", "````"],
      ["````", "`````"],
    ]) {
      const code = `before\n${run}\nafter`;
      const expected = `${fence}ts\n${code}\n${fence}`;
      expect(fencedCodeBlock(code, "ts")).toBe(expected);
      expect(renderRichMarkdown(`<pre><code class="language-ts">${code}</code></pre>`)).toBe(
        expected,
      );
    }
  });

  test("generated schema links use escaped fallback without changing unrelated text", () => {
    expect(
      new TweetContent({ text: "body", timestamp: "t[x]", permalink: "javascript:x" }).toMarkdown(),
    ).toContain("t\\[x\\]");
    expect(
      new TweetThread({
        author_name: "A[B]",
        author_handle: "a",
        author_url: "data:x",
        tweets: [],
      }).toMarkdown(),
    ).toBe("**Author**: A\\[B\\] (@a)");
    expect(new XTimelineTweet({ id: "1", url: "javascript:x" }).toMarkdown()).toBe("link");
    expect(new DeepWikiCitation({ label: "L[x]", target_url: "javascript:x" }).toMarkdown()).toBe(
      "L\\[x\\]",
    );
    expect(
      new LinkList([
        { url: "javascript:x", title: "T[x]", section: "", category: "" },
      ]).toMarkdown(),
    ).toBe("- T\\[x\\]");
  });
});

import { describe, expect, test } from "bun:test";
import { buildTimeline } from "../src/handlers/x";

function cell(
  id: string,
  options: { author?: string; reply?: boolean; social?: string } = {},
): { id: string; html: string } {
  const author = options.author ?? "sampleuser";
  return {
    id,
    html: `<div data-testid="cellInnerDiv">
      ${options.social ? `<div data-testid="socialContext">${options.social}</div>` : ""}
      <article data-testid="tweet">
        <div data-testid="User-Name"><a href="/${author}">${author}</a><span>@${author}</span></div>
        ${options.reply ? "<div>Replying to @someone</div>" : ""}
        <div data-testid="tweetText">tweet ${id}</div>
        <a href="/${author}/status/${id}"><time datetime="2025-01-01T00:00:00Z">now</time></a>
      </article>
    </div>`,
  };
}

describe("X timeline pure loop", () => {
  test("applies the limit to emitted tweets after reply and repost filtering", () => {
    const cells = [
      cell("500", { reply: true }),
      cell("499", { author: "other", social: "Other reposted" }),
      cell("498"),
      cell("497"),
    ];
    const result = buildTimeline(cells, "sampleuser", { limit: 2 });
    expect(result.structured.tweets.map((tweet) => tweet.id)).toEqual(["498", "497"]);
    expect(result.selected_html).toContain("tweet 500");
    expect(result.structured.next_cursor).toBe("497");
  });

  test("distinguishes bottom, catch-up, and limit evidence", () => {
    const cells = [cell("500"), cell("499")];
    expect(
      buildTimeline(cells, "sampleuser", { limit: 10 }, { hitBottom: true }).structured.next_cursor,
    ).toBeNull();
    expect(
      buildTimeline(cells, "sampleuser", { limit: 1 }, { hitBottom: true }).structured.next_cursor,
    ).toBe("500");
    const caughtUp = buildTimeline(cells, "sampleuser", { limit: 10, sinceId: "499" });
    expect(caughtUp.structured.tweets.map((tweet) => tweet.id)).toEqual(["500"]);
    expect(caughtUp.structured.next_cursor).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { PresetDriftError } from "../src/errors";
import {
  buildTimeline,
  finalizeTimelineHarvest,
  harvestTimelineFrame,
  scrapeTimeline,
} from "../src/handlers/x";

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

  test("rejects evidence-free offline completion and final loop boundaries", async () => {
    await expect(
      scrapeTimeline("https://x.com/sampleuser", { html: '<div id="primaryColumn"></div>' }),
    ).rejects.toBeInstanceOf(PresetDriftError);

    const inconsistent = { cells: [], classifiableIds: ["500"], providerEmpty: false };
    expect(() => finalizeTimelineHarvest(inconsistent, "sampleuser")).toThrow(PresetDriftError);

    const state = { cells: [], classifiableIds: [], providerEmpty: false };
    for (const evidence of [
      { hitBottom: true },
      { warning: "scroll_stalled" as const },
      { warning: "max_scrolls_reached" as const },
    ]) {
      expect(() => finalizeTimelineHarvest(state, "sampleuser", {}, evidence)).toThrow(
        "no classifiable tweets or allowlisted provider-empty state",
      );
    }
  });

  test("does not harvest classifiable tweets outside the primary timeline", async () => {
    for (const outside of [
      cell("500").html,
      cell("499", { author: "other", social: "Other reposted" }).html,
    ]) {
      const html = `<div id="primaryColumn"></div><aside>${outside}</aside>`;
      const harvested = harvestTimelineFrame(undefined, html, "sampleuser");
      expect(harvested.state.cells).toEqual([]);
      expect(harvested.state.classifiableIds).toEqual([]);
      await expect(scrapeTimeline("https://x.com/sampleuser", { html })).rejects.toBeInstanceOf(
        PresetDriftError,
      );
    }
  });

  test("accepts only an allowlisted empty marker descended from the primary timeline", async () => {
    const result = await scrapeTimeline("https://x.com/sampleuser", {
      html: '<div data-testid="primaryColumn"><div><h2 data-testid="emptyState">No posts</h2></div></div>',
    });
    expect(result.structured.tweets).toEqual([]);
    expect(result.structured.next_cursor).toBeNull();
    expect(
      result.structured.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
      })),
    ).toEqual([
      {
        code: "no_tweets_found",
        message: "X explicitly reported that this timeline is empty",
      },
    ]);

    for (const html of [
      '<div data-testid="emptyState">No posts</div><div id="primaryColumn"></div>',
      '<div id="primaryColumn"><h2>No posts yet</h2></div>',
      '<div id="primaryColumn"><div data-testid="cellInnerDiv"><a href="/sampleuser/status/123">loading</a></div></div>',
    ]) {
      await expect(scrapeTimeline("https://x.com/sampleuser", { html })).rejects.toBeInstanceOf(
        PresetDriftError,
      );
    }
  });

  test("classifiable evidence validates zero results after cursor and content filters", () => {
    const cases = [
      {
        result: buildTimeline([cell("500")], "sampleuser", { sinceId: "500" }),
        cursor: null,
      },
      {
        result: buildTimeline([cell("500", { reply: true })], "sampleuser", {}),
        cursor: "500",
      },
      {
        result: buildTimeline(
          [cell("500", { author: "other", social: "Other reposted" })],
          "sampleuser",
          {},
        ),
        cursor: null,
      },
    ];
    for (const { result, cursor } of cases) {
      expect(result.structured.tweets).toEqual([]);
      expect(result.structured.warnings).toEqual([]);
      expect(result.structured.next_cursor).toBe(cursor);
    }
  });

  test("classifiable evidence beats stale explicit-empty evidence", () => {
    const empty = harvestTimelineFrame(
      undefined,
      '<div id="primaryColumn"><div data-testid="emptyState">No posts</div></div>',
      "sampleuser",
    );
    const classified = harvestTimelineFrame(
      empty.state,
      `<div id="primaryColumn">${cell("500", { reply: true }).html}</div>`,
      "sampleuser",
    );
    const result = finalizeTimelineHarvest(classified.state, "sampleuser");
    expect(result.structured.tweets).toEqual([]);
    expect(result.structured.warnings).toEqual([]);
  });

  test("same-ID hydration upgrades shells and never downgrades tweets", () => {
    const shell =
      '<div id="primaryColumn"><div data-testid="cellInnerDiv"><a href="/sampleuser/status/123">loading</a></div></div>';
    const hydrated = `<div id="primaryColumn">${cell("123").html}</div>`;

    const first = harvestTimelineFrame(undefined, shell, "sampleuser");
    expect(first.state.classifiableIds).toEqual([]);
    const upgraded = harvestTimelineFrame(first.state, hydrated, "sampleuser");
    expect(upgraded.state.classifiableIds).toEqual(["123"]);
    expect(finalizeTimelineHarvest(upgraded.state, "sampleuser").structured.tweets[0]?.text).toBe(
      "tweet 123",
    );

    const downgraded = harvestTimelineFrame(upgraded.state, shell, "sampleuser");
    expect(downgraded.state.classifiableIds).toEqual(["123"]);
    expect(finalizeTimelineHarvest(downgraded.state, "sampleuser").structured.tweets[0]?.text).toBe(
      "tweet 123",
    );
  });
});

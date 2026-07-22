export abstract class ScrapeSchema {
  abstract toMarkdown(): string;
}

function handle(value: string): string {
  const clean = value.trim();
  return clean && !clean.startsWith("@") ? `@${clean}` : clean;
}
function scalar(value: unknown): string {
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

export class GenericPage extends ScrapeSchema {
  constructor(
    public url = "",
    public content = "",
  ) {
    super();
  }
  toMarkdown(): string {
    return this.content;
  }
}

export interface TweetContentData {
  text: string;
  timestamp?: string;
  permalink?: string;
  links?: string[];
}
export class TweetContent extends ScrapeSchema {
  text: string;
  timestamp: string;
  permalink: string;
  links: string[];
  constructor(data: TweetContentData) {
    super();
    this.text = data.text;
    this.timestamp = data.timestamp ?? "";
    this.permalink = data.permalink ?? "";
    this.links = data.links ?? [];
  }
  toMarkdown(): string {
    const parts = [this.text.replace(/[ \t]+$/gm, "").trim()].filter(Boolean);
    if (this.timestamp) {
      parts.push(this.permalink ? `[${this.timestamp}](${this.permalink})` : this.timestamp);
    } else if (this.permalink) parts.push(this.permalink);
    const missing = [...new Set(this.links.filter((link) => link && !this.text.includes(link)))];
    if (missing.length) parts.push(missing.join("\n"));
    return parts.join("\n\n").trim();
  }
}

export class TweetThread extends ScrapeSchema {
  author_name: string;
  author_handle: string;
  author_url: string;
  tweets: TweetContent[];
  quoted_tweet: TweetContent | null;
  constructor(data: {
    author_name: string;
    author_handle: string;
    author_url?: string;
    tweets: TweetContent[];
    quoted_tweet?: TweetContent | null;
  }) {
    super();
    this.author_name = data.author_name;
    this.author_handle = data.author_handle;
    this.author_url = data.author_url ?? "";
    this.tweets = data.tweets;
    this.quoted_tweet = data.quoted_tweet ?? null;
  }
  toMarkdown(): string {
    const parts: string[] = [];
    const display = [this.author_name.trim(), handle(this.author_handle)]
      .filter(Boolean)
      .join(" (");
    const author = display.includes(" (") ? `${display})` : display;
    if (author)
      parts.push(`**Author**: ${this.author_url ? `[${author}](${this.author_url})` : author}`);
    const blocks = this.tweets.map((tweet) => tweet.toMarkdown()).filter(Boolean);
    if (blocks.length) parts.push(blocks.join("\n\n---\n\n"));
    if (this.quoted_tweet) {
      const quoted = this.quoted_tweet.toMarkdown();
      if (quoted)
        parts.push(
          `**Quoted Tweet:**\n${quoted
            .split("\n")
            .map((line) => (line ? `> ${line}` : ">"))
            .join("\n")}`,
        );
    }
    return parts.join("\n\n").trim();
  }
}

export class XProfile extends ScrapeSchema {
  display_name: string;
  handle: string;
  bio: string;
  header_text: string;
  following_text: string;
  followers_text: string;
  pinned_tweet: string;
  recent_posts: string[];
  recent_posts_structured: TweetContent[];
  latest_version: string;
  latest_post_id: string;
  constructor(data: {
    display_name: string;
    handle: string;
    bio?: string;
    header_text?: string;
    following_text?: string;
    followers_text?: string;
    pinned_tweet?: string;
    recent_posts?: string[];
    recent_posts_structured?: TweetContent[];
    latest_version?: string;
    latest_post_id?: string;
  }) {
    super();
    this.display_name = data.display_name;
    this.handle = data.handle;
    this.bio = data.bio ?? "";
    this.header_text = data.header_text ?? "";
    this.following_text = data.following_text ?? "";
    this.followers_text = data.followers_text ?? "";
    this.pinned_tweet = data.pinned_tweet ?? "";
    this.recent_posts = data.recent_posts ?? [];
    this.recent_posts_structured = data.recent_posts_structured ?? [];
    this.latest_version = data.latest_version ?? "";
    this.latest_post_id = data.latest_post_id ?? "";
  }
  toMarkdown(): string {
    const parts: string[] = [];
    const h = handle(this.handle);
    if (h || this.display_name) parts.push(`## ${h || this.display_name}`);
    if (this.display_name) parts.push(`**${this.display_name}**`);
    if (this.bio) parts.push(this.bio);
    const counts = [this.following_text, this.followers_text]
      .filter(Boolean)
      .map((x) => `**${x}**`);
    if (counts.length) parts.push(counts.join("  "));
    if (this.header_text) parts.push(this.header_text);
    const pinned = this.pinned_tweet.trim();
    const recent = this.recent_posts.map((x) => x.trim()).filter(Boolean);
    if (pinned || recent.length) parts.push("---");
    if (pinned) parts.push(`**Pinned:**\n\n${pinned}`);
    if (recent.length) {
      if (pinned) parts.push("---");
      parts.push(`**Recent:**\n\n${recent.join("\n\n---\n\n")}`);
    }
    return parts.join("\n\n").trim();
  }
}

export type WarningCode =
  | "scroll_stalled"
  | "max_scrolls_reached"
  | "no_tweets_found"
  | "partial_article_extract";
export class ScrapeWarning extends ScrapeSchema {
  constructor(
    public code: WarningCode,
    public message = "",
  ) {
    super();
  }
  toMarkdown(): string {
    return this.message ? `\`${this.code}\`: ${this.message}` : `\`${this.code}\``;
  }
}
function warningsMarkdown(warnings: ScrapeWarning[]): string {
  return `**Warnings:**\n\n${warnings.map((warning) => `- ${warning.toMarkdown()}`).join("\n")}`;
}

export class XTimelineTweet extends ScrapeSchema {
  id: string;
  url: string;
  text: string;
  created_at: string;
  is_reply: boolean;
  is_repost: boolean;
  is_quote: boolean;
  is_pinned: boolean;
  article_urls: string[];
  constructor(data: {
    id: string;
    url: string;
    text?: string;
    created_at?: string;
    is_reply?: boolean;
    is_repost?: boolean;
    is_quote?: boolean;
    is_pinned?: boolean;
    article_urls?: string[];
  }) {
    super();
    this.id = data.id;
    this.url = data.url;
    this.text = data.text ?? "";
    this.created_at = data.created_at ?? "";
    this.is_reply = data.is_reply ?? false;
    this.is_repost = data.is_repost ?? false;
    this.is_quote = data.is_quote ?? false;
    this.is_pinned = data.is_pinned ?? false;
    this.article_urls = data.article_urls ?? [];
  }
  toMarkdown(): string {
    const lines = [this.text.trim()].filter(Boolean);
    const tags = [
      ["pinned", this.is_pinned],
      ["repost", this.is_repost],
      ["reply", this.is_reply],
      ["quote", this.is_quote],
    ]
      .filter(([, on]) => on)
      .map(([name]) => `\`${name}\``);
    const meta = [...tags, this.created_at, this.url ? `[link](${this.url})` : ""].filter(Boolean);
    if (meta.length) lines.push(meta.join(" · "));
    return lines.join("\n\n").trim();
  }
}

export class XTimeline extends ScrapeSchema {
  handle: string;
  next_cursor: string | null;
  scraped_at: string;
  tweets: XTimelineTweet[];
  warnings: ScrapeWarning[];
  constructor(data: {
    handle: string;
    next_cursor?: string | null;
    scraped_at?: string;
    tweets?: XTimelineTweet[];
    warnings?: ScrapeWarning[];
  }) {
    super();
    this.handle = data.handle;
    this.next_cursor = data.next_cursor ?? null;
    this.scraped_at = data.scraped_at ?? "";
    this.tweets = data.tweets ?? [];
    this.warnings = data.warnings ?? [];
  }
  toMarkdown(): string {
    const parts: string[] = [];
    if (this.handle.trim()) parts.push(`## ${handle(this.handle)}`);
    const blocks = this.tweets.map((tweet) => tweet.toMarkdown()).filter(Boolean);
    if (blocks.length) parts.push(blocks.join("\n\n---\n\n"));
    if (this.warnings.length) parts.push(warningsMarkdown(this.warnings));
    return parts.join("\n\n").trim();
  }
}

export class XArticle extends ScrapeSchema {
  url: string;
  title: string;
  author_handle: string;
  published_at: string;
  markdown: string;
  links: string[];
  warnings: ScrapeWarning[];
  constructor(data: {
    url: string;
    title?: string;
    author_handle?: string;
    published_at?: string;
    markdown?: string;
    links?: string[];
    warnings?: ScrapeWarning[];
  }) {
    super();
    this.url = data.url;
    this.title = data.title ?? "";
    this.author_handle = data.author_handle ?? "";
    this.published_at = data.published_at ?? "";
    this.markdown = data.markdown ?? "";
    this.links = data.links ?? [];
    this.warnings = data.warnings ?? [];
  }
  toMarkdown(): string {
    const parts: string[] = [];
    if (this.title) parts.push(`# ${this.title}`);
    const meta = [handle(this.author_handle), this.published_at].filter(Boolean);
    if (meta.length) parts.push(meta.join(" · "));
    const markdown = this.markdown.replace(/[ \t]+$/gm, "").trim();
    if (markdown) parts.push(markdown);
    if (this.warnings.length) parts.push(warningsMarkdown(this.warnings));
    return parts.join("\n\n").trim();
  }
}

export class ConversationTurn extends ScrapeSchema {
  constructor(
    public role: string,
    public content: string,
  ) {
    super();
  }
  toMarkdown(): string {
    const role = this.role.trim().toLowerCase();
    const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : role || "Unknown";
    return `## ${label[0]!.toUpperCase()}${label.slice(1)}${this.content.trim() ? `\n\n${this.content.trim()}` : ""}`;
  }
}
export class ChatGPTConversation extends ScrapeSchema {
  constructor(public turns: ConversationTurn[]) {
    super();
  }
  toMarkdown(): string {
    return this.turns
      .map((turn) => turn.toMarkdown())
      .join("\n\n---\n\n")
      .trim();
  }
}

export class DeepWikiCitation extends ScrapeSchema {
  label: string;
  target_url: string;
  repo_path: string;
  line_start: number | null;
  line_end: number | null;
  constructor(data: {
    label: string;
    target_url?: string;
    repo_path?: string;
    line_start?: number | null;
    line_end?: number | null;
  }) {
    super();
    this.label = data.label;
    this.target_url = data.target_url ?? "";
    this.repo_path = data.repo_path ?? "";
    this.line_start = data.line_start ?? null;
    this.line_end = data.line_end ?? null;
  }
  toMarkdown(): string {
    let location = this.repo_path;
    if (location && this.line_start !== null) {
      location += `#L${this.line_start}`;
      if (this.line_end !== null && this.line_end !== this.line_start)
        location += `-L${this.line_end}`;
    }
    const label = this.label.trim() || location || this.target_url;
    let entry = this.target_url ? `[${label}](${this.target_url})` : label;
    if (location && location !== label) entry += ` (${location})`;
    return entry;
  }
}
export class DeepWikiWikiPage extends ScrapeSchema {
  url: string;
  repository: string;
  title: string;
  markdown: string;
  citations: DeepWikiCitation[];
  constructor(
    data: {
      url?: string;
      repository?: string;
      title?: string;
      markdown?: string;
      citations?: DeepWikiCitation[];
    } = {},
  ) {
    super();
    this.url = data.url ?? "";
    this.repository = data.repository ?? "";
    this.title = data.title ?? "";
    this.markdown = data.markdown ?? "";
    this.citations = data.citations ?? [];
  }
  toMarkdown(): string {
    const parts = [
      this.title ? `# ${this.title}` : "",
      this.repository ? `\`${this.repository}\`` : "",
      this.markdown.trim(),
    ].filter(Boolean);
    if (this.citations.length)
      parts.push(
        `## Citations\n\n${this.citations.map((citation) => `- ${citation.toMarkdown()}`).join("\n")}`,
      );
    return parts.join("\n\n").trim();
  }
}
export class DeepWikiQARound extends ScrapeSchema {
  question: string;
  answer: string;
  citations: DeepWikiCitation[];
  constructor(data: { question?: string; answer?: string; citations?: DeepWikiCitation[] }) {
    super();
    this.question = data.question ?? "";
    this.answer = data.answer ?? "";
    this.citations = data.citations ?? [];
  }
  toMarkdown(): string {
    const parts = [
      this.question.trim() ? `### Q: ${this.question.trim()}` : "",
      this.answer.trim(),
    ].filter(Boolean);
    if (this.citations.length)
      parts.push(
        `**Citations:**\n\n${this.citations.map((citation) => `- ${citation.toMarkdown()}`).join("\n")}`,
      );
    return parts.join("\n\n").trim();
  }
}
export class DeepWikiSearchConversation extends ScrapeSchema {
  url: string;
  repository: string;
  rounds: DeepWikiQARound[];
  constructor(data: { url?: string; repository?: string; rounds?: DeepWikiQARound[] } = {}) {
    super();
    this.url = data.url ?? "";
    this.repository = data.repository ?? "";
    this.rounds = data.rounds ?? [];
  }
  toMarkdown(): string {
    const parts = [this.repository ? `\`${this.repository}\`` : ""];
    const rounds = this.rounds.map((round) => round.toMarkdown()).filter(Boolean);
    if (rounds.length) parts.push(rounds.join("\n\n---\n\n"));
    return parts.filter(Boolean).join("\n\n").trim();
  }
}

export interface LinkItem {
  url: string;
  title: string;
  section: string;
  category: string;
}
export class LinkList extends ScrapeSchema {
  constructor(public links: LinkItem[]) {
    super();
  }
  toMarkdown(): string {
    return this.links
      .map((link) => {
        const title = link.title || link.url;
        const entry = link.url ? `[${title}](${link.url})` : title;
        const meta = [link.section, link.category].filter(Boolean);
        return `- ${entry}${meta.length ? ` (${meta.join(" / ")})` : ""}`;
      })
      .join("\n")
      .trim();
  }
}

export class ClaudeUsage extends ScrapeSchema {
  current_session_pct: number | null;
  current_session_reset: number | null;
  weekly_all_models_pct: number | null;
  weekly_all_models_reset: number | null;
  weekly_sonnet_pct: number | null;
  weekly_sonnet_reset: number | null;
  extra_usage_enabled: boolean;
  extra_usage_spent: number;
  extra_usage_reset: number | null;
  monthly_spending_limit: number;
  current_balance: number;
  auto_reload: boolean;
  constructor(data: Partial<ClaudeUsage> = {}) {
    super();
    this.current_session_pct = data.current_session_pct ?? null;
    this.current_session_reset = data.current_session_reset ?? null;
    this.weekly_all_models_pct = data.weekly_all_models_pct ?? null;
    this.weekly_all_models_reset = data.weekly_all_models_reset ?? null;
    this.weekly_sonnet_pct = data.weekly_sonnet_pct ?? null;
    this.weekly_sonnet_reset = data.weekly_sonnet_reset ?? null;
    this.extra_usage_enabled = data.extra_usage_enabled ?? false;
    this.extra_usage_spent = data.extra_usage_spent ?? 0;
    this.extra_usage_reset = data.extra_usage_reset ?? null;
    this.monthly_spending_limit = data.monthly_spending_limit ?? 0;
    this.current_balance = data.current_balance ?? 0;
    this.auto_reload = data.auto_reload ?? false;
  }
  toMarkdown(): string {
    const parts = ["## Claude.ai Usage"];
    const quota = (label: string, value: number | null, reset: number | null) => {
      if (value !== null)
        parts.push(`**${label}**: ${value}${reset !== null ? ` (${reset})` : ""}`);
    };
    quota("Current session", this.current_session_pct, this.current_session_reset);
    quota("Weekly (all models)", this.weekly_all_models_pct, this.weekly_all_models_reset);
    quota("Weekly (Sonnet)", this.weekly_sonnet_pct, this.weekly_sonnet_reset);
    parts.push(`**Extra usage**: ${scalar(this.extra_usage_enabled)}`);
    parts.push(
      `**Extra usage spent**: ${this.extra_usage_spent}${this.extra_usage_reset !== null ? ` (${this.extra_usage_reset})` : ""}`,
    );
    parts.push(`**Monthly spending limit**: ${this.monthly_spending_limit}`);
    parts.push(`**Current balance**: ${this.current_balance}`);
    parts.push(`**Auto-reload**: ${scalar(this.auto_reload)}`);
    return parts.join("\n\n");
  }
}
export interface ClaudeInvoice {
  date: string;
  due: string;
  total: number | null;
  status: string;
}
export class ClaudeBilling extends ScrapeSchema {
  plan_label: string;
  current_plan: number;
  plan_details: string;
  renews_on: string;
  current_balance: number | null;
  auto_reload: boolean | null;
  invoices: ClaudeInvoice[];
  constructor(
    data: {
      plan_label?: string;
      current_plan?: number;
      plan_details?: string;
      renews_on?: string;
      current_balance?: number | null;
      auto_reload?: boolean | null;
      invoices?: ClaudeInvoice[];
    } = {},
  ) {
    super();
    this.plan_label = data.plan_label ?? "";
    this.current_plan = data.current_plan ?? 0;
    this.plan_details = data.plan_details ?? "";
    this.renews_on = data.renews_on ?? "";
    this.current_balance = data.current_balance ?? null;
    this.auto_reload = data.auto_reload ?? null;
    this.invoices = data.invoices ?? [];
  }
  toMarkdown(): string {
    const parts = ["## Claude.ai Billing", `**Current plan**: ${this.current_plan}`];
    if (this.plan_label) parts.push(`**Plan label**: ${this.plan_label}`);
    if (this.plan_details) parts.push(`**Plan details**: ${this.plan_details}`);
    if (this.renews_on) parts.push(`**Renews on**: ${this.renews_on}`);
    if (this.current_balance !== null) parts.push(`**Current balance**: ${this.current_balance}`);
    if (this.auto_reload !== null) parts.push(`**Auto-reload**: ${scalar(this.auto_reload)}`);
    if (this.invoices.length) {
      const rows = this.invoices.map(
        (x) =>
          `| ${x.date} | ${x.due} | ${x.total === null ? "" : `$${x.total.toFixed(2)}`} | ${x.status} |`,
      );
      parts.push(
        `## Invoices\n\n| Date | Due | Total | Status |\n| --- | --- | --- | --- |\n${rows.join("\n")}`,
      );
    }
    return parts.join("\n\n");
  }
}
export class CodexUsage extends ScrapeSchema {
  plan: string;
  five_hour_remaining_pct: number | null;
  five_hour_reset: number | null;
  weekly_remaining_pct: number | null;
  weekly_reset: number | null;
  code_review_remaining_pct: number | null;
  credits_remaining: number | null;
  constructor(data: Partial<CodexUsage> = {}) {
    super();
    this.plan = data.plan ?? "";
    this.five_hour_remaining_pct = data.five_hour_remaining_pct ?? null;
    this.five_hour_reset = data.five_hour_reset ?? null;
    this.weekly_remaining_pct = data.weekly_remaining_pct ?? null;
    this.weekly_reset = data.weekly_reset ?? null;
    this.code_review_remaining_pct = data.code_review_remaining_pct ?? null;
    this.credits_remaining = data.credits_remaining ?? null;
  }
  toMarkdown(): string {
    const parts = ["## Codex Usage"];
    if (this.plan) parts.push(`**Plan**: ${this.plan}`);
    if (this.five_hour_remaining_pct !== null)
      parts.push(
        `**5-hour limit**: ${this.five_hour_remaining_pct}${this.five_hour_reset !== null ? ` (${this.five_hour_reset})` : ""}`,
      );
    if (this.weekly_remaining_pct !== null)
      parts.push(
        `**Weekly limit**: ${this.weekly_remaining_pct}${this.weekly_reset !== null ? ` (${this.weekly_reset})` : ""}`,
      );
    if (this.code_review_remaining_pct !== null)
      parts.push(`**Code review**: ${this.code_review_remaining_pct}`);
    if (this.credits_remaining !== null)
      parts.push(`**Credits remaining**: ${this.credits_remaining}`);
    return parts.join("\n\n");
  }
}

abstract class SimpleBilling extends ScrapeSchema {
  protected markdown(title: string, values: [string, unknown][]): string {
    const parts = [`## ${title}`];
    for (const [label, value] of values)
      if (value !== null && value !== "") parts.push(`**${label}**: ${scalar(value)}`);
    return parts.join("\n\n");
  }
}
export class PerplexityBilling extends SimpleBilling {
  constructor(
    public credit_balance: number | null = null,
    public usage_tier: number | null = null,
    public auto_reload: boolean | null = null,
  ) {
    super();
  }
  toMarkdown(): string {
    return this.markdown("Perplexity API Billing", [
      ["Credit balance", this.credit_balance],
      ["Usage tier", this.usage_tier],
      ["Auto-reload", this.auto_reload],
    ]);
  }
}
export class OpenAIBilling extends SimpleBilling {
  constructor(
    public organization = "",
    public plan_type = "",
    public credit_balance: number | null = null,
    public auto_recharge: boolean | null = null,
  ) {
    super();
  }
  toMarkdown(): string {
    return this.markdown("OpenAI Platform Billing", [
      ["Organization", this.organization],
      ["Plan", this.plan_type],
      ["Credit balance", this.credit_balance],
      ["Auto-recharge", this.auto_recharge],
    ]);
  }
}
export class AnthropicBilling extends SimpleBilling {
  constructor(
    public organization = "",
    public credit_balance: number | null = null,
    public auto_reload: boolean | null = null,
  ) {
    super();
  }
  toMarkdown(): string {
    return this.markdown("Anthropic Platform Billing", [
      ["Organization", this.organization],
      ["Credit balance", this.credit_balance],
      ["Auto-reload", this.auto_reload],
    ]);
  }
}

export type FailureClass =
  | "invalid_request"
  | "authentication_required"
  | "upstream_unavailable"
  | "timeout"
  | "browser_error"
  | "provider_error"
  | "malformed_provider_output"
  | "empty_content"
  | "output_limit_exceeded"
  | "cancelled"
  | "internal_error";
export interface ExtractionEnvelope {
  schema_version: "1";
  status: "success" | "failure";
  requested_url: string;
  final_url: string | null;
  extractor: {
    name: "agentscrape";
    version: string;
    implementation: string;
    implementation_version: string;
  };
  artifacts: Array<{
    artifact_type: "document";
    media_type: "text/markdown";
    encoding: "utf-8";
    content: string;
    size_bytes: number;
    sha256: string;
  }>;
  metadata: {
    content_type: "web_page" | "social_post" | "article";
    title: string;
    author_name: string;
    author_handle: string;
    published_at: string;
    source_id: string;
    warnings: "partial_content"[];
  } | null;
  relations: Array<{ relation_type: "references"; target_url: string }>;
  failure: {
    failure_class: FailureClass;
    retryable: boolean;
    message: string;
    evidence: string;
  } | null;
}

export interface FeedPageValidators {
  etag: string | null;
  last_modified: string | null;
}
export interface FeedDiscoveryItem {
  stable_id: string;
  upstream_id: string | null;
  identity_source: "upstream_id" | "canonical_url" | "hashed_upstream_id";
  url: string | null;
  candidate_urls: string[];
  title: string;
  published_at: string | null;
  updated_at: string | null;
  tombstone: boolean;
}
export interface FeedDiscoveryResult {
  schema_version: "1";
  status: "success" | "partial" | "failure";
  source_url: string;
  source_format: "rss" | "atom" | "archive" | "mixed" | "unknown";
  validators: FeedPageValidators;
  cursor: {
    validators: FeedPageValidators;
    newest_seen_at: string | null;
    next_url: string | null;
  };
  items: FeedDiscoveryItem[];
  pagination: {
    pages: Array<{
      url: string;
      page_format: "rss" | "atom" | "archive";
      validators: FeedPageValidators;
      item_count: number;
      next_url: string | null;
    }>;
    complete: boolean;
    stop_reason: string;
    next_url: string | null;
  };
  warnings: Array<{ code: string; message: string; page_url?: string }>;
  absence_implies_deletion: false;
  failure: { code: string; retryable: boolean; message: string } | null;
}

import type { ScrapeSchema } from "../schemas";

export interface ScrapeResult<T extends ScrapeSchema = ScrapeSchema> {
  full_html: string;
  selected_html: string;
  markdown: string;
  structured: T;
  links?: Array<{ url: string; title: string; section: string; category: string }>;
  final_url?: string;
}
export interface HandlerOptions {
  session?: string | null | undefined;
  html?: string | null | undefined;
  media?: string | null | undefined;
  browserProfile?: string | null | undefined;
  limit?: number | undefined;
  maxScrolls?: number | undefined;
  sinceId?: string | null | undefined;
  includeReplies?: boolean | undefined;
  includeReposts?: boolean | undefined;
  signal?: AbortSignal | undefined;
}
export type ContentHandler = (url: string, options?: HandlerOptions) => Promise<ScrapeResult>;

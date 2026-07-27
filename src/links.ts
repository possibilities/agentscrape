import * as cheerio from "cheerio";
import { openPage, requireAgentBrowserSuccess, runAgentBrowser } from "./browser";
import { browserEval, browserEvalString } from "./browser-eval";
import { AgentscrapeBrowserError, AgentscrapeValueError, PresetDriftError } from "./errors";
import type { HandlerOptions } from "./handlers/types";
import { safeLink } from "./html";
import type { LinkItem } from "./schemas";

interface BrowserLink {
  url: string;
  title: string;
  category: string;
}
interface LinkSnapshot {
  rootCount: number;
  links: BrowserLink[];
}
interface ToggleInfo {
  count: number;
  rootCount: number;
  labels: string[];
}

function baseFor(value: string): string {
  const url = new URL(value);
  const segment = url.pathname.split("/").filter(Boolean)[0];
  url.pathname = segment ? `/${segment}` : "/";
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function sameBase(value: string, base: string): boolean {
  try {
    const url = new URL(value, base);
    const root = new URL(base);
    return (
      url.origin === root.origin &&
      (root.pathname === "/" ||
        url.pathname === root.pathname ||
        url.pathname.startsWith(`${root.pathname}/`))
    );
  } catch {
    return false;
  }
}

function snapshotCode(selector: string, toggleSelector?: string): string {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const toggleSelector = ${JSON.stringify(toggleSelector ?? "")};
    const selected = [...document.querySelectorAll(selector)];
    const roots = selected.map(node => ({node, category: ""}));
    const scopedToggles = toggleSelector ? selected.flatMap(root => [
      ...(root.matches(toggleSelector) ? [root] : []),
      ...root.querySelectorAll(toggleSelector),
    ]) : [];
    const toggles = scopedToggles.length ? scopedToggles : (toggleSelector ? [
      ...document.querySelectorAll('[role="tablist"] ' + toggleSelector),
    ] : []);
    for (const toggle of toggles) {
      const controls = toggle.getAttribute('aria-controls');
      if (!controls) continue;
      const panel = document.getElementById(controls);
      if (!panel) continue;
      const label = (toggle.getAttribute('aria-label') || toggle.textContent || "").replace(/\\s+/g, " ").trim();
      roots.push({node: panel, category: label});
    }
    const visible = element => {
      if (element.closest('[hidden],[aria-hidden="true"]')) return false;
      let current = element;
      while (current && current.nodeType === 1) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        current = current.parentElement;
      }
      return true;
    };
    const out = []; const seen = new Set();
    for (const entry of roots) {
      let category = entry.category;
      const root = entry.node;
      const nodes = [root, ...root.querySelectorAll('*')];
      for (const element of nodes) {
        if (!visible(element)) continue;
        if (/^H[1-6]$/.test(element.tagName)) category = (element.textContent || "").replace(/\\s+/g, " ").trim();
        if (!element.matches('a[href],[role="tab"],button[aria-controls],[role="button"][aria-controls]')) continue;
        const title = (element.getAttribute('aria-label') || element.textContent || "").replace(/\\s+/g, " ").trim();
        let href = element.getAttribute('href');
        if (!href || href.startsWith('javascript:')) {
          const key = element.getAttribute('data-value') || title || element.getAttribute('aria-controls') || element.id;
          if (!key) continue;
          href = '#tab-' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        }
        let url;
        try { url = new URL(href, location.href).href; } catch { continue; }
        const key = url + '\\n' + category;
        if (!seen.has(key)) { seen.add(key); out.push({url, title: title || href, category}); }
      }
    }
    return {rootCount: selected.length, links: out};
  })()`;
}

function validSnapshot(value: unknown): value is LinkSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.rootCount === "number" &&
    Array.isArray(item.links) &&
    item.links.every(
      (link) =>
        link &&
        typeof link === "object" &&
        typeof (link as Record<string, unknown>).url === "string" &&
        typeof (link as Record<string, unknown>).title === "string" &&
        typeof (link as Record<string, unknown>).category === "string",
    )
  );
}

async function browserSnapshot(
  selector: string,
  session?: string | null,
  toggleSelector?: string,
): Promise<LinkSnapshot> {
  let last: LinkSnapshot = { rootCount: 0, links: [] };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await browserEval(
      snapshotCode(selector, toggleSelector),
      session,
      `Failed to extract links for selector '${selector}'`,
    );
    if (!validSnapshot(value))
      throw new AgentscrapeBrowserError(
        `Failed to extract links for selector '${selector}': invalid eval result`,
      );
    last = value;
    if (last.rootCount && last.links.length) return last;
    if (attempt < 2) {
      const waited = await runAgentBrowser(["wait", "1000"], session);
      requireAgentBrowserSuccess(waited, "Failed while waiting for links");
    }
  }
  return last;
}

async function discoverToggles(
  selector: string,
  toggleSelector: string,
  session?: string | null,
): Promise<ToggleInfo> {
  const value = await browserEval(
    `(() => {
      const roots = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const scoped = roots.flatMap(root => [
        ...(root.matches(${JSON.stringify(toggleSelector)}) ? [root] : []),
        ...root.querySelectorAll(${JSON.stringify(toggleSelector)}),
      ]);
      const items = scoped.length ? scoped : [...document.querySelectorAll('[role="tablist"] ' + ${JSON.stringify(toggleSelector)})];
      return {rootCount: roots.length, count: items.length, labels: items.map(item =>
        (item.getAttribute('aria-label') || item.textContent || '').replace(/\\s+/g, ' ').trim()
      )};
    })()`,
    session,
    `Failed to find toggles for selector '${selector}'`,
  );
  if (!value || typeof value !== "object")
    throw new AgentscrapeBrowserError(
      `Failed to find toggles for selector '${selector}': invalid eval result`,
    );
  const info = value as Record<string, unknown>;
  if (
    typeof info.rootCount !== "number" ||
    typeof info.count !== "number" ||
    !Array.isArray(info.labels) ||
    !info.labels.every((label) => typeof label === "string")
  )
    throw new AgentscrapeBrowserError(
      `Failed to find toggles for selector '${selector}': invalid eval result`,
    );
  return info as unknown as ToggleInfo;
}

async function clickToggle(
  selector: string,
  toggleSelector: string,
  index: number,
  session?: string | null,
): Promise<void> {
  const value = await browserEval(
    `(() => {
      const roots = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const scoped = roots.flatMap(root => [
        ...(root.matches(${JSON.stringify(toggleSelector)}) ? [root] : []),
        ...root.querySelectorAll(${JSON.stringify(toggleSelector)}),
      ]);
      const items = scoped.length ? scoped : [...document.querySelectorAll('[role="tablist"] ' + ${JSON.stringify(toggleSelector)})];
      const item = items[${index}];
      if (!item) return false;
      item.click();
      return true;
    })()`,
    session,
    `Failed to click toggle ${index + 1}`,
  );
  if (typeof value !== "boolean")
    throw new AgentscrapeBrowserError(`Failed to click toggle ${index + 1}: invalid eval result`);
  if (!value)
    throw new PresetDriftError(
      `toggle_selector '${toggleSelector}' changed while expanding '${selector}'`,
    );
  const waited = await runAgentBrowser(["wait", "500"], session);
  requireAgentBrowserSuccess(waited, "Failed while waiting for toggle expansion");
}

async function collectLinks(
  selector: string,
  toggleSelector: string | undefined,
  session?: string | null,
): Promise<BrowserLink[]> {
  const initial = await browserSnapshot(selector, session, toggleSelector);
  if (!initial.rootCount)
    throw new PresetDriftError(`required selector '${selector}' was not found`);
  const collected = [...initial.links];
  if (!toggleSelector) return collected;
  const toggles = await discoverToggles(selector, toggleSelector, session);
  if (!toggles.rootCount)
    throw new PresetDriftError(`required selector '${selector}' was not found`);
  if (!toggles.count)
    throw new PresetDriftError(
      `toggle_selector '${toggleSelector}' found no toggles in '${selector}'`,
    );
  for (let index = 0; index < toggles.count; index += 1) {
    const before = await browserSnapshot(selector, session, toggleSelector);
    const beforeUrls = new Set(before.links.map((link) => link.url));
    await clickToggle(selector, toggleSelector, index, session);
    const after = await browserSnapshot(selector, session, toggleSelector);
    const label = toggles.labels[index] ?? "";
    for (const link of after.links) {
      if (!beforeUrls.has(link.url)) collected.push({ ...link, category: label || link.category });
    }
  }
  return collected;
}

async function openAndBase(url: string, options: HandlerOptions): Promise<string> {
  await openPage(url, options.session, options.media);
  const actual = await browserEvalString(
    "window.location.href",
    options.session,
    "Failed to determine the opened page URL",
  );
  return baseFor(actual.startsWith("http") ? actual : url);
}

function normalizeLinks(
  raw: BrowserLink[],
  base: string,
  section: string,
  seen: Set<string>,
): LinkItem[] {
  const links: LinkItem[] = [];
  for (const item of raw) {
    let absolute: string;
    try {
      absolute = new URL(item.url, base).href;
    } catch {
      continue;
    }
    if (!sameBase(absolute, base) || seen.has(absolute)) continue;
    seen.add(absolute);
    links.push({ url: absolute, title: item.title, section, category: item.category });
  }
  return links;
}

export async function scrapeLinks(
  url: string,
  selector: string,
  toggleSelector?: string,
  options: HandlerOptions = {},
): Promise<LinkItem[]> {
  const base = await openAndBase(url, options);
  const raw = await collectLinks(selector, toggleSelector, options.session);
  if (!raw.length) throw new PresetDriftError(`selector '${selector}' produced no links at ${url}`);
  const section = new URL(url).pathname.replace(/\/$/, "").split("/").pop() ?? "";
  const links = normalizeLinks(raw, base, section, new Set());
  if (!links.length)
    throw new PresetDriftError(
      `Link scraping found no URLs matching base path. selector='${selector}' at ${url}`,
    );
  return links;
}

export async function scrapeNavLinks(
  url: string,
  sectionSelector: string,
  categorySelector: string,
  toggleSelector?: string,
  options: HandlerOptions = {},
): Promise<LinkItem[]> {
  const base = await openAndBase(url, options);
  const sections = await collectLinks(sectionSelector, undefined, options.session);
  if (!sections.length)
    throw new PresetDriftError(`section_selector '${sectionSelector}' produced no links at ${url}`);
  const links: LinkItem[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    const sectionUrl = new URL(section.url, base).href;
    if (!sameBase(sectionUrl, base)) continue;
    await openPage(sectionUrl, options.session, options.media);
    const categories = await collectLinks(categorySelector, toggleSelector, options.session);
    if (!categories.length)
      throw new PresetDriftError(
        `category_selector '${categorySelector}' produced no links at ${sectionUrl}`,
      );
    links.push(...normalizeLinks(categories, base, section.title, seen));
  }
  if (!links.length)
    throw new PresetDriftError(`Navigation scraping found no URLs matching base path at ${url}`);
  return links;
}

export function offlineExtractLinks(
  html: string,
  selector: string,
  baseUrl: string,
): Array<{ url: string; title: string; category: string }> {
  const $ = cheerio.load(html);
  const roots = $(selector);
  if (!roots.length)
    throw new AgentscrapeValueError(
      `required selector '${selector}' was not found (offline replay)`,
    );
  const links: Array<{ url: string; title: string; category: string }> = [];
  const seen = new Set<string>();
  roots.each((_rootIndex, root) => {
    let category = "";
    const elements = [root, ...$(root).find("*").toArray()];
    for (const element of elements) {
      if (!("tagName" in element)) continue;
      if (/^h[1-6]$/i.test(element.tagName))
        category = $(element).text().replace(/\s+/g, " ").trim();
      if (element.tagName !== "a") continue;
      const href = $(element).attr("href");
      const link = safeLink(href, baseUrl);
      if (!link || seen.has(link)) continue;
      seen.add(link);
      links.push({
        url: link,
        title: $(element).text().replace(/\s+/g, " ").trim(),
        category,
      });
    }
  });
  if (!links.length)
    throw new AgentscrapeValueError(`selector '${selector}' found no links (offline replay)`);
  return links;
}

import * as cheerio from "cheerio";

/** Validate CSS with the same selector engine used by offline extraction. */
export function cssSelectorProblem(selector: string): string | null {
  if (!selector) return "selector must not be empty";
  try {
    cheerio.load("")(selector);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

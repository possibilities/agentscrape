import { describe, expect, test } from "bun:test";
import { decodeBrowserEval, decodeBrowserEvalString } from "../src/browser-eval";
import { AgentscrapeBrowserError } from "../src/errors";

describe("agent-browser eval contract", () => {
  test("strictly decodes JSON-encoded string values", () => {
    const html = '<html data-value="quoted">line\nnext</html>';
    expect(decodeBrowserEvalString(JSON.stringify(html))).toBe(html);
  });

  test("rejects bare, malformed, and non-string output for string captures", () => {
    for (const output of ["<html></html>", "undefined", "{bad json"]) {
      expect(() => decodeBrowserEvalString(output, "capture")).toThrow("invalid JSON");
      expect(() => decodeBrowserEvalString(output, "capture")).toThrow(AgentscrapeBrowserError);
    }
    for (const output of ["null", "false", '{"html":"value"}']) {
      expect(() => decodeBrowserEvalString(output, "capture")).toThrow("non-string");
      expect(() => decodeBrowserEvalString(output, "capture")).toThrow(AgentscrapeBrowserError);
    }
  });

  test("retains structured JSON for timeline and link evals", () => {
    expect(decodeBrowserEval('{"html":"<main></main>","scrollTop":0}')).toEqual({
      html: "<main></main>",
      scrollTop: 0,
    });
  });
});

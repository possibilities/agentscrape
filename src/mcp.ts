/**
 * The transport. `agentscrape mcp` calls this and does not return until the
 * host closes stdio.
 *
 * Nothing else may write to stdout while this is running: stdout is the protocol
 * channel. Every command's output goes back through the tool result instead,
 * which is why the server dispatches `main` with an output sink rather than
 * letting a command print.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentscrapeMcpServer } from "./mcp-server";

export async function serveAgentscrapeMcp(signal?: AbortSignal): Promise<void> {
  const server = createAgentscrapeMcpServer();
  await server.connect(new StdioServerTransport());
  // connect() returns as soon as the transport is listening. The process stays
  // alive on stdin, and this resolves when the host closes it.
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    // The SDK's stdio transport subscribes to `data` and `error` and to nothing
    // else, so EOF on stdin reaches it as silence rather than as a close, and a
    // host that exits without killing the child would leave this process
    // resident with no way to be spoken to. EOF is the transport closing; the
    // contract says this command serves until then, so say it here.
    const closed = () => {
      void server.close();
    };
    process.stdin.once("end", closed);
    process.stdin.once("close", closed);

    // The entrypoint installs SIGINT and SIGTERM handlers, which suppresses the
    // runtime's own terminate-on-signal. Every other command reaches that
    // controller through its `signal`; serving reached nothing, so a SIGTERM
    // aborted a controller no one was listening to and the process stayed
    // resident until SIGKILL. A stdio server is built to outlive its caller,
    // which is exactly why it has to be told to stop.
    if (signal !== undefined) {
      if (signal.aborted) closed();
      else signal.addEventListener("abort", closed, { once: true });
    }
  });
}

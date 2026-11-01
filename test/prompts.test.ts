import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPrompts } from "../src/prompts.js";

test("original module skills are exposed as Bridge-aware MCP prompts", async (t) => {
  const server = new McpServer({ name: "prompt-test", version: "1" });
  registerPrompts(server);
  const client = new Client({ name: "prompt-test-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => { await client.close(); await server.close(); });

  const prompts = await client.listPrompts();
  assert.deepEqual(prompts.prompts.map(p => p.name), [
    "lark-mcp-guide", "feishu-calendar", "feishu-task", "feishu-people",
    "feishu-im", "feishu-interactive-cards", "feishu-watch-loop", "feishu-doc", "lark-tool-design",
  ]);
  const guide = await client.getPrompt({ name: "lark-mcp-guide" });
  assert.match(String(guide.messages[0]?.content?.text), /single long connection/);
  assert.match(String(guide.messages[0]?.content?.text), /does not expose the old `feishu_im_watch`/);
  const calendar = await client.getPrompt({ name: "feishu-calendar" });
  assert.match(String(calendar.messages[0]?.content?.text), /abbreviated IDs/);
  const loop = await client.getPrompt({ name: "feishu-watch-loop" });
  assert.match(String(loop.messages[0]?.content?.text), /The bridge acknowledges delivered events/);
  const messaging = await client.getPrompt({ name: "feishu-im" });
  assert.match(String(messaging.messages[0]?.content?.text), /broker receives and batches events/i);
});

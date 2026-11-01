/** Expose the project's skill files through the same MCP prompt interface as the original server. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const skills = [
  { name: "lark-mcp-guide", file: "skills/feishu/SKILL.md", description: "Lark Bridge tools, identifiers, authentication, and event delivery" },
  { name: "feishu-calendar", file: "skills/feishu/feishu-calendar/SKILL.md", description: "Create, find, update, and delete personal calendar events" },
  { name: "feishu-task", file: "skills/feishu/feishu-task/SKILL.md", description: "Manage personal tasks and task lists" },
  { name: "feishu-people", file: "skills/feishu/feishu-people/SKILL.md", description: "Find a Lark user's open ID" },
  { name: "feishu-im", file: "skills/feishu/feishu-im/SKILL.md", description: "Send, read, search, and edit messages and attachments" },
  { name: "feishu-interactive-cards", file: "skills/feishu/feishu-interactive-cards/SKILL.md", description: "Confirm, form, progress, and custom card guidance" },
  { name: "feishu-watch-loop", file: "skills/feishu/feishu-watch-loop/SKILL.md", description: "Bridge-delivered Lark messages, card actions, reminders, and chat subscriptions" },
  { name: "feishu-doc", file: "skills/feishu/feishu-doc/SKILL.md", description: "Create, read, edit, search, and delete Lark documents" },
  { name: "lark-tool-design", file: ".agents/skills/lark-tool-design/SKILL.md", description: "Review or design the agent-facing Lark Bridge tool interface" },
] as const;

export function registerPrompts(server: McpServer) {
  for (const skill of skills) {
    const content = readFileSync(join(projectRoot, skill.file), "utf8");
    server.prompt(skill.name, skill.description, () => ({
      messages: [{ role: "user", content: { type: "text", text: content } }],
    }));
  }
}

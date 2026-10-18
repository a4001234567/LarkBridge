import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  buildConfirmRespondedCard,
  buildFormSubmittedCard,
  type CardEntry,
} from "./cards/interactive.js";
import { buildProgressCard } from "./cards/progress.js";

export type Interaction = {
  id: string;
  chat_id: string;
  message_id?: string;
  expires_at: number;
  kind: "confirm" | "form" | "progress" | "custom";
  data: any;
  responses?: Record<string, any>;
  status?: string;
};
export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    this.db = new DatabaseSync(join(dir, "bridge.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, name TEXT, harness TEXT, live INTEGER DEFAULT 0, paused INTEGER DEFAULT 0, seen INTEGER);
      CREATE TABLE IF NOT EXISTS routes(chat TEXT PRIMARY KEY, session TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats(chat TEXT PRIMARY KEY, type TEXT, peer TEXT);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, chat TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, received INTEGER NOT NULL, acked INTEGER DEFAULT 0, lease_session TEXT, lease_token TEXT, lease_until INTEGER DEFAULT 0, response TEXT);
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY, chat TEXT NOT NULL, message TEXT UNIQUE, expires INTEGER NOT NULL, state TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');`);
    this.db.exec(`INSERT OR IGNORE INTO chats(chat,type,peer)
      SELECT e.chat,
        COALESCE(json_extract(e.payload,'$.event.message.chat_type'),json_extract(e.payload,'$.message.chat_type')),
        CASE WHEN COALESCE(json_extract(e.payload,'$.event.message.chat_type'),json_extract(e.payload,'$.message.chat_type'))='p2p'
          THEN COALESCE(json_extract(e.payload,'$.event.sender.sender_id.open_id'),json_extract(e.payload,'$.sender.sender_id.open_id'))
          ELSE NULL END
      FROM events e
      WHERE e.type='im.message.receive_v1'
        AND COALESCE(json_extract(e.payload,'$.event.message.chat_type'),json_extract(e.payload,'$.message.chat_type')) IS NOT NULL
      ORDER BY e.received DESC`);
    this.db.exec(
      "UPDATE sessions SET live=0; UPDATE events SET lease_until=0, lease_token=NULL, lease_session=NULL WHERE acked=0",
    );
  }
  register(id: string, name: string, harness: string) {
    this.db
      .prepare(
        "INSERT INTO sessions(id,name,harness,live,seen) VALUES(?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,harness=excluded.harness,live=1,seen=excluded.seen",
      )
      .run(id, name, harness, Date.now());
  }
  disconnect(id: string) {
    this.db.prepare("UPDATE sessions SET live=0 WHERE id=?").run(id);
    this.db
      .prepare(
        "UPDATE events SET lease_until=0,lease_token=NULL,lease_session=NULL WHERE lease_session=? AND acked=0",
      )
      .run(id);
  }
  route(chat: string, session: string) {
    if (!this.db.prepare("SELECT id FROM sessions WHERE id=?").get(session))
      throw new Error("Unknown destination session");
    this.db
      .prepare(
        "INSERT INTO routes VALUES(?,?) ON CONFLICT(chat) DO UPDATE SET session=excluded.session",
      )
      .run(chat, session);
    this.db
      .prepare(
        "UPDATE events SET lease_until=0,lease_token=NULL,lease_session=NULL WHERE chat=? AND acked=0",
      )
      .run(chat);
  }
  pause(id: string, paused: boolean) {
    this.db.prepare("UPDATE sessions SET paused=? WHERE id=?").run(+paused, id);
  }
  list() {
    return {
      sessions: this.db.prepare("SELECT * FROM sessions").all(),
      routes: this.db.prepare("SELECT * FROM routes").all(),
    };
  }
  chatForPeer(peer: string): string {
    const row = this.db.prepare("SELECT chat FROM chats WHERE type='p2p' AND peer=? LIMIT 1").get(peer) as { chat: string } | undefined;
    if (!row) throw new Error("No known p2p chat for this user");
    return row.chat;
  }
  interaction(input: Interaction) {
    this.db
      .prepare(
        "INSERT INTO interactions(id,chat,message,expires,state) VALUES(?,?,?,?,?)",
      )
      .run(
        input.id,
        input.chat_id,
        input.message_id ?? null,
        input.expires_at,
        JSON.stringify(input),
      );
  }
  bind(id: string, message: string) {
    this.db
      .prepare("UPDATE interactions SET message=? WHERE id=?")
      .run(message, id);
  }
  cancel(id: string) {
    this.db
      .prepare(
        "UPDATE interactions SET status='cancelled' WHERE id=? AND status='active'",
      )
      .run(id);
  }
  getInteraction(id: string): any {
    return this.db
      .prepare("SELECT * FROM interactions WHERE id=? OR message=?")
      .get(id, id);
  }
  updateProgress(
    id: string,
    currentStep: number,
    updates: Array<{ index: number; detail: string }>,
  ) {
    const row = this.getInteraction(id);
    if (!row) throw new Error("Progress card not found");
    const entry = JSON.parse(row.state);
    if (entry.kind !== "progress") throw new Error("Not a progress card");
    if (row.status !== "active")
      return { ...entry, message_id: row.message, status: row.status };
    entry.data.currentStep = currentStep;
    for (const update of updates)
      if (entry.data.steps[update.index])
        entry.data.steps[update.index].detail = update.detail;
    this.db
      .prepare("UPDATE interactions SET state=? WHERE id=?")
      .run(JSON.stringify(entry), row.id);
    return { ...entry, message_id: row.message, status: row.status };
  }
  expire() {
    this.db
      .prepare(
        "UPDATE interactions SET status='expired' WHERE status='active' AND expires<=?",
      )
      .run(Date.now());
  }
  ingest(raw: any): {
    id: string;
    chat: string;
    response: any;
    duplicate: boolean;
  } {
    const event = raw.event ?? raw;
    const type = raw.header?.event_type ?? raw.type ?? event.type ?? "unknown";
    const chat =
      event.context?.open_chat_id ??
      event.message?.chat_id ??
      event.chat_id ??
      event.open_chat_id;
    if (typeof chat !== "string" || !chat)
      throw new Error("Event has no originating chat ID");
    const id =
      raw.header?.event_id ??
      raw.uuid ??
      createHash("sha256").update(JSON.stringify(raw)).digest("hex");
    const previous: any = this.db
      .prepare("SELECT response FROM events WHERE id=?")
      .get(id);
    if (previous)
      return {
        id,
        chat,
        response: JSON.parse(previous.response ?? "{}"),
        duplicate: true,
      };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (type === "im.message.receive_v1" && event.message?.chat_type) {
        const chatType = event.message.chat_type;
        const peer = chatType === "p2p" ? event.sender?.sender_id?.open_id ?? null : null;
        this.db.prepare(
          "INSERT INTO chats(chat,type,peer) VALUES(?,?,?) ON CONFLICT(chat) DO UPDATE SET type=excluded.type,peer=COALESCE(excluded.peer,chats.peer)",
        ).run(chat, chatType, peer);
      }
      let response: any = {};
      if (type === "card.action.trigger") {
        const action = event.action ?? {};
        const correlation = action.value?.bridge_interaction_id;
        const row: any = correlation
          ? this.db
              .prepare("SELECT * FROM interactions WHERE id=? AND chat=?")
              .get(correlation, chat)
          : this.db
              .prepare("SELECT * FROM interactions WHERE message=? AND chat=?")
              .get(event.context?.open_message_id ?? "", chat);
        const value =
          action.value?.action ??
          (action.form_value ? "form_submit" : "unknown");
        response = { toast: { type: "info", content: "正在处理..." } };
        if (row && row.status === "active" && row.expires > Date.now()) {
          const entry: Interaction = JSON.parse(row.state);
          let card;
          if (entry.kind === "confirm" && ["confirm", "cancel"].includes(value))
            card = buildConfirmRespondedCard(entry.data as CardEntry, value);
          if (entry.kind === "form" && action.form_value)
            card = buildFormSubmittedCard(entry.data, action.form_value);
          if (entry.kind === "progress" && value === "stop")
            card = buildProgressCard(
              entry.data.title,
              entry.data.steps,
              entry.data.currentStep ?? 0,
              true,
            );
          if (card)
            response = {
              toast: {
                type: "info",
                content: value === "stop" ? "已停止" : "已处理",
              },
              card: { type: "raw", data: card },
            };
          if (entry.responses?.[value]) response = entry.responses[value];
          if (card || entry.responses?.[value])
            this.db
              .prepare("UPDATE interactions SET status='responded' WHERE id=?")
              .run(row.id);
        } else if (row)
          response = {
            toast: { type: "info", content: "此操作已处理或已失效" },
          };
      }
      this.db
        .prepare(
          "INSERT INTO events(id,chat,type,payload,received,response) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          chat,
          type,
          JSON.stringify(raw),
          Date.now(),
          JSON.stringify(response),
        );
      this.db.exec("COMMIT");
      return { id, chat, response, duplicate: false };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  pending(session: string, interaction?: string) {
    const card = interaction ? this.getInteraction(interaction) : undefined;
    const filter = interaction
      ? " AND e.type='card.action.trigger' AND (json_extract(e.payload,'$.event.action.value.bridge_interaction_id')=? OR json_extract(e.payload,'$.event.context.open_message_id')=?)"
      : "";
    const params: Array<string | number | null> = [session, Date.now()];
    if (interaction) params.push(interaction, card?.message ?? null);
    return this.db
      .prepare(
        `SELECT e.id,e.chat AS chat_id,e.type,c.type AS chat_type,c.peer AS peer_id FROM events e JOIN routes r ON r.chat=e.chat JOIN sessions s ON s.id=r.session LEFT JOIN chats c ON c.chat=e.chat WHERE e.acked=0 AND r.session=? AND s.paused=0 AND s.live=1 AND e.lease_until<=?${filter} ORDER BY e.received LIMIT 100`,
      )
      .all(...params);
  }
  claim(session: string, limit = 20, interaction?: string) {
    const rows: any[] = this.pending(session, interaction).slice(0, limit);
    return rows.map((row) => {
      const token = randomBytes(16).toString("base64url");
      this.db
        .prepare(
          "UPDATE events SET lease_session=?,lease_token=?,lease_until=? WHERE id=?",
        )
        .run(session, token, Date.now() + 60_000, row.id);
      const full: any = this.db
        .prepare("SELECT payload,received FROM events WHERE id=?")
        .get(row.id);
      return {
        ...row,
        payload: JSON.parse(full.payload),
        received_at: full.received,
        receipt: token,
      };
    });
  }
  ack(session: string, id: string | undefined, receipt: string) {
    const idFilter = id ? " AND id=?" : "";
    const result = this.db
      .prepare(
        `UPDATE events SET acked=1 WHERE lease_session=? AND lease_token=? AND lease_until>? AND chat IN (SELECT chat FROM routes WHERE session=?)${idFilter}`,
      )
      .run(...(id ? [session, receipt, Date.now(), session, id] : [session, receipt, Date.now(), session]));
    if (!result.changes) throw new Error("Receipt expired or event reassigned");
  }
  raw(session: string, id: string | undefined, receipt: string) {
    const idFilter = id ? " AND e.id=?" : "";
    const row: any = this.db
      .prepare(
        `SELECT e.id,e.chat AS chat_id,e.type,e.payload,e.received AS received_at
         FROM events e JOIN routes r ON r.chat=e.chat
         WHERE e.acked=0 AND e.lease_session=? AND e.lease_token=?
           AND e.lease_until>? AND r.session=?${idFilter}`,
      )
      .get(...(id ? [session, receipt, Date.now(), session, id] : [session, receipt, Date.now(), session]));
    if (!row) throw new Error("Receipt expired or event reassigned");
    return { ...row, payload: JSON.parse(row.payload), receipt };
  }
  close() {
    this.db.close();
  }
}

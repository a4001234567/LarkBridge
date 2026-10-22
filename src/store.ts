import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  buildConfirmRespondedCard,
  buildFormSubmittedCard,
  type CardEntry,
} from "./cards/interactive.js";
import { buildProgressCard } from "./cards/progress.js";
import { Cron } from "croner";
import { matches, overlaps, type Subscription, type SubscriptionMode } from "./subscriptions.js";

export type Interaction = {
  id: string;
  chat_id: string;
  message_id?: string;
  expires_at: number;
  kind: "confirm" | "form" | "progress" | "custom" | "proxy_token";
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
      CREATE TABLE IF NOT EXISTS subscriptions(session TEXT PRIMARY KEY, mode TEXT NOT NULL, chats TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats(chat TEXT PRIMARY KEY, type TEXT, peer TEXT);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, chat TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, received INTEGER NOT NULL, acked INTEGER DEFAULT 0, lease_session TEXT, lease_token TEXT, lease_until INTEGER DEFAULT 0, response TEXT);
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY, chat TEXT NOT NULL, message TEXT UNIQUE, expires INTEGER NOT NULL, state TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');`);
    const columns = this.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "target_session"))
      this.db.exec("ALTER TABLE events ADD COLUMN target_session TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS schedules(
      id TEXT PRIMARY KEY, session TEXT NOT NULL, label TEXT NOT NULL,
      fire_at INTEGER NOT NULL, cron TEXT, timezone TEXT)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS proxy_tokens(
      hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`);
    this.db.exec(`INSERT OR IGNORE INTO subscriptions(session,mode,chats)
      SELECT session,'only',json_group_array(chat) FROM routes GROUP BY session`);
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
    const saved = this.subscription(id);
    const conflict = saved && this.liveSubscriptions(id).some(other => overlaps(saved, other));
    if (conflict) {
      this.db.prepare("DELETE FROM subscriptions WHERE session=?").run(id);
      this.db.prepare("DELETE FROM routes WHERE session=?").run(id);
    }
    this.db
      .prepare(
        "INSERT INTO sessions(id,name,harness,live,seen) VALUES(?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,harness=excluded.harness,live=1,seen=excluded.seen",
      )
      .run(id, name, harness, Date.now());
    return { subscription_dropped: !!conflict };
  }
  disconnect(id: string) {
    this.db.prepare("UPDATE sessions SET live=0 WHERE id=?").run(id);
    this.db
      .prepare(
        "UPDATE events SET lease_until=0,lease_token=NULL,lease_session=NULL WHERE lease_session=? AND acked=0",
      )
      .run(id);
    // Hook clients are short-lived and never own chat subscriptions.
    this.db.prepare("DELETE FROM sessions WHERE id=? AND harness='hook'").run(id);
  }
  route(chat: string, session: string) {
    const current = this.subscription(session);
    if (current?.mode === "all") return this.subscribe(session, "all", []);
    if (current?.mode === "all_except")
      return this.subscribe(session, "all_except", current.chats.filter(value => value !== chat));
    return this.subscribe(session, "only", [...(current?.chats ?? []), chat]);
  }
  private subscription(session: string): Subscription | undefined {
    const row = this.db.prepare("SELECT session,mode,chats FROM subscriptions WHERE session=?")
      .get(session) as { session: string; mode: SubscriptionMode; chats: string } | undefined;
    return row && { session: row.session, mode: row.mode, chats: JSON.parse(row.chats) };
  }
  private liveSubscriptions(except?: string): Subscription[] {
    const rows = this.db.prepare(`SELECT sub.session,sub.mode,sub.chats FROM subscriptions sub
      JOIN sessions s ON s.id=sub.session WHERE s.live=1 AND sub.session<>?`)
      .all(except ?? "") as Array<{ session: string; mode: SubscriptionMode; chats: string }>;
    return rows.map(row => ({ session: row.session, mode: row.mode, chats: JSON.parse(row.chats) }));
  }
  private owner(chat: string): string | undefined {
    return this.liveSubscriptions().find(sub => matches(sub, chat))?.session;
  }
  subscribe(session: string, mode: SubscriptionMode, chats: string[] = []) {
    const target = this.db.prepare("SELECT live FROM sessions WHERE id=?")
      .get(session) as { live: number } | undefined;
    if (!target) throw new Error("Unknown destination session");
    if (!target.live) throw new Error("Destination session is not live");
    const normalized = [...new Set(chats)];
    if (normalized.some(chat => !chat.startsWith("oc_"))) throw new Error("Invalid chat ID");
    if (mode === "all" && normalized.length) throw new Error("All-chats filter must have no chat list");
    const next: Subscription = { session, mode, chats: normalized };
    const conflict = this.liveSubscriptions(session).find(other => overlaps(next, other));
    if (conflict) throw new Error(`Chats already held by live session ${conflict.session}`);
    const eventChats = this.db.prepare("SELECT DISTINCT chat FROM events WHERE acked=0")
      .all() as Array<{ chat: string }>;
    const before = new Map(eventChats.map(row => [row.chat, this.owner(row.chat)]));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A live claim can take chats from an offline explicit subscription.
      const offline = this.db.prepare(`SELECT sub.session,sub.chats FROM subscriptions sub
        JOIN sessions s ON s.id=sub.session WHERE s.live=0 AND sub.mode='only'`)
        .all() as Array<{ session: string; chats: string }>;
      for (const row of offline) {
        const retained = (JSON.parse(row.chats) as string[]).filter(chat => !matches(next, chat));
        this.db.prepare("UPDATE subscriptions SET chats=? WHERE session=?")
          .run(JSON.stringify(retained), row.session);
        this.db.prepare("DELETE FROM routes WHERE session=?").run(row.session);
        for (const chat of retained)
          this.db.prepare("INSERT OR REPLACE INTO routes(chat,session) VALUES(?,?)").run(chat, row.session);
      }
      this.db.prepare(`INSERT INTO subscriptions(session,mode,chats) VALUES(?,?,?)
        ON CONFLICT(session) DO UPDATE SET mode=excluded.mode,chats=excluded.chats`)
        .run(session, mode, JSON.stringify(normalized));
      this.db.prepare("DELETE FROM routes WHERE session=?").run(session);
      if (mode === "only") for (const chat of normalized)
        this.db.prepare("INSERT OR REPLACE INTO routes(chat,session) VALUES(?,?)").run(chat, session);
      for (const row of eventChats) if (before.get(row.chat) !== this.owner(row.chat))
        this.db.prepare(`UPDATE events SET lease_until=0,lease_token=NULL,lease_session=NULL
          WHERE chat=? AND acked=0`).run(row.chat);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return next;
  }
  pause(id: string, paused: boolean) {
    this.db.prepare("UPDATE sessions SET paused=? WHERE id=?").run(+paused, id);
  }
  list() {
    return {
      sessions: this.db.prepare("SELECT * FROM sessions").all(),
      routes: this.db.prepare("SELECT * FROM routes").all(),
      subscriptions: this.db.prepare("SELECT session,mode,chats FROM subscriptions").all()
        .map((row: any) => ({ ...row, chats: JSON.parse(row.chats) })),
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
  createSchedule(session: string, label: string, fireAt?: string, cron?: string, timezone = "Asia/Shanghai") {
    if (!this.db.prepare("SELECT id FROM sessions WHERE id=?").get(session))
      throw new Error("Unknown destination session");
    let fireTime = fireAt ? new Date(fireAt).getTime() : NaN;
    if (cron) {
      let next: Date | null;
      try { next = new Cron(cron, { timezone }).nextRun(); }
      catch { throw new Error("Invalid cron expression or timezone"); }
      if (!next) throw new Error("Cron has no future occurrence");
      if (!fireAt) fireTime = next.getTime();
    }
    if (!Number.isFinite(fireTime)) throw new Error("Provide a valid fire_at or cron");
    const id = randomBytes(12).toString("hex");
    this.db.prepare("INSERT INTO schedules(id,session,label,fire_at,cron,timezone) VALUES(?,?,?,?,?,?)")
      .run(id, session, label, fireTime, cron ?? null, timezone);
    return { id, session_id: session, label, fire_at: new Date(fireTime).toISOString(), cron, timezone };
  }
  listSchedules(session: string) {
    return this.db.prepare("SELECT id,label,fire_at,cron,timezone FROM schedules WHERE session=? ORDER BY fire_at")
      .all(session).map((row: any) => ({ ...row, fire_at: new Date(row.fire_at).toISOString() }));
  }
  deleteSchedule(session: string, id: string) {
    return this.db.prepare("DELETE FROM schedules WHERE session=? AND id=?").run(session, id).changes > 0;
  }
  issueProxyToken(hash: string, expires: number) {
    if (!/^[a-f0-9]{64}$/.test(hash) || expires <= Date.now())
      throw new Error("Invalid proxy token registration");
    this.db.prepare("INSERT INTO proxy_tokens(hash,expires) VALUES(?,?)").run(hash, expires);
  }
  proxyTokenStatus(hash: string) {
    const row = this.db.prepare("SELECT expires,revoked FROM proxy_tokens WHERE hash=?")
      .get(hash) as { expires: number; revoked: number } | undefined;
    return { valid: !!row && !row.revoked && row.expires > Date.now(),
      revoked: !!row?.revoked, expires_at: row?.expires };
  }
  revokeProxyToken(hash: string) {
    return this.db.prepare("UPDATE proxy_tokens SET revoked=1 WHERE hash=? AND revoked=0")
      .run(hash).changes > 0;
  }
  fireSchedules(now = Date.now()) {
    const due = this.db.prepare("SELECT * FROM schedules WHERE fire_at<=? ORDER BY fire_at")
      .all(now) as Array<{ id: string; session: string; label: string; fire_at: number; cron: string | null; timezone: string }>;
    if (!due.length) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const schedule of due) {
        const payload = { event: { schedule: {
          id: schedule.id, label: schedule.label,
          scheduled_for: new Date(schedule.fire_at).toISOString(),
        } } };
        this.db.prepare(`INSERT OR IGNORE INTO events(id,chat,type,payload,received,target_session)
          VALUES(?,?,?,?,?,?)`).run(
          `schedule:${schedule.id}:${schedule.fire_at}`, "__schedule__", "bridge.schedule.fire",
          JSON.stringify(payload), now, schedule.session,
        );
        let next: Date | null = null;
        if (schedule.cron) try {
          next = new Cron(schedule.cron, { timezone: schedule.timezone, startAt: new Date(now) }).nextRun();
        } catch {}
        if (next) this.db.prepare("UPDATE schedules SET fire_at=? WHERE id=?").run(next.getTime(), schedule.id);
        else this.db.prepare("DELETE FROM schedules WHERE id=?").run(schedule.id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return due.length;
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
          if (entry.kind === "proxy_token" && value === "stop_token")
            this.revokeProxyToken(entry.data.token_hash);
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
        `SELECT e.id,e.chat AS chat_id,e.type,e.received,c.type AS chat_type,c.peer AS peer_id
         FROM events e JOIN sessions s ON s.id=?
         LEFT JOIN subscriptions sub ON sub.session=s.id LEFT JOIN chats c ON c.chat=e.chat
         WHERE e.acked=0 AND s.paused=0 AND s.live=1 AND e.lease_until<=?
           AND (e.target_session=s.id OR (e.target_session IS NULL AND (sub.mode='all'
             OR (sub.mode='only' AND EXISTS(SELECT 1 FROM json_each(sub.chats) WHERE value=e.chat))
             OR (sub.mode='all_except' AND NOT EXISTS(SELECT 1 FROM json_each(sub.chats) WHERE value=e.chat)))))
           ${filter} ORDER BY e.received LIMIT 100`,
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
    const row = this.db.prepare(`SELECT id,chat,target_session FROM events WHERE lease_session=?
      AND lease_token=? AND lease_until>? AND acked=0${idFilter}`)
      .get(...(id ? [session, receipt, Date.now(), id] : [session, receipt, Date.now()])) as
      { id: string; chat: string; target_session: string | null } | undefined;
    if (!row || (row.target_session ?? this.owner(row.chat)) !== session)
      throw new Error("Receipt expired or event reassigned");
    const result = this.db.prepare("UPDATE events SET acked=1 WHERE id=? AND acked=0").run(row.id);
    if (!result.changes) throw new Error("Receipt expired or event reassigned");
  }
  raw(session: string, id: string | undefined, receipt: string) {
    const idFilter = id ? " AND id=?" : "";
    const row: any = this.db
      .prepare(
        `SELECT id,chat AS chat_id,type,payload,received AS received_at,target_session
         FROM events WHERE acked=0 AND lease_session=? AND lease_token=?
           AND lease_until>?${idFilter}`,
      )
      .get(...(id ? [session, receipt, Date.now(), id] : [session, receipt, Date.now()]));
    if (!row || (row.target_session ?? this.owner(row.chat_id)) !== session)
      throw new Error("Receipt expired or event reassigned");
    return { ...row, payload: JSON.parse(row.payload), receipt };
  }
  close() {
    this.db.close();
  }
}

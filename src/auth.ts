import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { Config } from "./config.js";

type Token = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  granted_scopes?: string[];
  owner_open_id?: string;
};
export class Auth {
  private user?: Token;
  private tenant?: { token: string; expires: number };
  private refreshing?: Promise<string>;
  private tenantRequest?: Promise<string>;
  private timer: ReturnType<typeof setInterval>;
  private flow?: {
    device_code: string;
    verification_url: string;
    expires: number;
    nextPoll: number;
    interval: number;
    status: string;
    scopes: string[];
  };
  private polling = false;
  private starting?: Promise<any>;
  private file: string;
  constructor(
    private cfg: Config,
    private request: typeof fetch = fetch,
  ) {
    this.file = join(cfg.stateDir, "tokens.json");
    if (!cfg.offline && !cfg.appSecret)
      throw new Error(
        "Broker requires LARK_APP_SECRET or appSecret in its config",
      );
    if (existsSync(this.file))
      this.user = this.decode(JSON.parse(readFileSync(this.file, "utf8")));
    else if (cfg.tokenImport) {
      const raw = JSON.parse(readFileSync(cfg.tokenImport, "utf8"));
      const entry = raw[cfg.appId] ?? (raw.access_token ? raw : undefined);
      if (entry) {
        this.user = this.decode(entry);
        this.save();
      }
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, 30_000);
    this.timer.unref();
  }
  private key() {
    if (!this.cfg.appSecret) throw new Error("Missing app secret");
    return createHash("sha256").update(this.cfg.appSecret).digest();
  }
  private decode(entry: any): Token {
    if (entry.version !== 2) return entry;
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key(),
      Buffer.from(entry.iv, "hex"),
    );
    cipher.setAuthTag(Buffer.from(entry.tag, "hex"));
    return JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(entry.data, "hex")),
        cipher.final(),
      ]).toString(),
    );
  }
  private save() {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(this.user)),
      cipher.final(),
    ]);
    writeFileSync(
      this.file + ".tmp",
      JSON.stringify({
        version: 2,
        iv: iv.toString("hex"),
        tag: cipher.getAuthTag().toString("hex"),
        data: data.toString("hex"),
      }),
      { mode: 0o600 },
    );
    renameSync(this.file + ".tmp", this.file);
  }
  private async post(
    path: string,
    body: Record<string, string>,
    form = false,
    base = this.cfg.domain,
  ) {
    const response = await this.request(base + path, {
      method: "POST",
      headers: {
        "Content-Type": form
          ? "application/x-www-form-urlencoded"
          : "application/json",
      },
      body: form ? new URLSearchParams(body) : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`Lark authentication HTTP ${response.status}`);
    return (await response.json()) as any;
  }
  status() {
    return {
      authenticated: !!this.user && this.user.expires_at > Date.now(),
      expires_at: this.user?.expires_at,
      scopes: this.user?.granted_scopes ?? [],
      oauth: this.flow
        ? {
            status: this.flow.status,
            verification_url: this.flow.verification_url,
            expires_at: this.flow.expires,
          }
        : undefined,
    };
  }
  async token(kind: "tenant" | "user"): Promise<string> {
    if (this.cfg.offline)
      throw new Error("Authentication disabled in offline mode");
    if (kind === "tenant") {
      if (this.tenant && this.tenant.expires > Date.now() + 60_000)
        return this.tenant.token;
      if (!this.tenantRequest)
        this.tenantRequest = this.post(
          "/open-apis/auth/v3/tenant_access_token/internal",
          { app_id: this.cfg.appId, app_secret: this.cfg.appSecret! },
        )
          .then((r) => {
            if (r.code !== 0 || !r.tenant_access_token)
              throw new Error("Tenant authentication failed");
            this.tenant = {
              token: r.tenant_access_token,
              expires: Date.now() + (r.expire ?? 7200) * 1000,
            };
            return this.tenant.token;
          })
          .finally(() => {
            this.tenantRequest = undefined;
          });
      return this.tenantRequest;
    }
    if (!this.user?.refresh_token)
      throw new Error("Not authenticated. Use feishu_auth_init.");
    if (this.user.expires_at > Date.now() + 300_000)
      return this.user.access_token;
    if (!this.refreshing)
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
  private async refresh() {
    const source = this.user!;
    const r = await this.post(
      "/open-apis/authen/v2/oauth/token",
      {
        grant_type: "refresh_token",
        client_id: this.cfg.appId,
        client_secret: this.cfg.appSecret!,
        refresh_token: source.refresh_token,
      },
      true,
    );
    if (this.user !== source) return this.user!.access_token;
    if (r.error || !r.access_token)
      throw new Error("OAuth refresh failed; reauthorization may be required");
    this.user = {
      ...this.user!,
      access_token: r.access_token,
      refresh_token: r.refresh_token ?? this.user!.refresh_token,
      expires_at: Date.now() + (r.expires_in ?? 7200) * 1000,
    };
    this.save();
    return this.user.access_token;
  }
  async start(scope: string) {
    if (this.starting) return this.starting;
    this.starting = this.begin(scope).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async begin(scope: string) {
    if (this.cfg.offline)
      throw new Error("Authentication disabled in offline mode");
    if (this.flow?.status === "pending") return this.status().oauth;
    // Reserve before awaiting so simultaneous MCP calls share one device flow.
    this.flow = {
      device_code: "",
      verification_url: "",
      expires: Date.now() + 600_000,
      nextPoll: Infinity,
      interval: 5,
      status: "pending",
      scopes: [],
    };
    try {
      const scopes = [
        ...new Set([
          ...(this.user?.granted_scopes ?? []),
          ...scope.split(/\s+/).filter(Boolean),
          "offline_access",
        ]),
      ];
      const accounts = this.cfg.domain.includes("larksuite.com")
        ? "https://accounts.larksuite.com"
        : "https://accounts.feishu.cn";
      const r = await this.post(
        "/oauth/v1/device_authorization",
        {
          client_id: this.cfg.appId,
          client_secret: this.cfg.appSecret!,
          scope: scopes.join(" "),
        },
        true,
        accounts,
      );
      if (r.error || !r.device_code)
        throw new Error("Could not start OAuth device flow");
      this.flow = {
        device_code: r.device_code,
        verification_url: r.verification_uri_complete ?? r.verification_uri,
        expires: Date.now() + (r.expires_in ?? 300) * 1000,
        nextPoll: Date.now() + (r.interval ?? 5) * 1000,
        interval: r.interval ?? 5,
        status: "pending",
        scopes,
      };
      return this.status().oauth;
    } catch (e) {
      this.flow = undefined;
      throw e;
    }
  }
  async tick() {
    if (this.cfg.offline) return;
    try {
      if (this.user && this.user.expires_at <= Date.now() + 300_000)
        await this.token("user");
    } catch {
      process.stderr.write(
        "[bridge] OAuth refresh failed; retrying on next maintenance tick\n",
      );
    }
    const f = this.flow;
    if (!f || f.status !== "pending" || this.polling || Date.now() < f.nextPoll)
      return;
    if (Date.now() >= f.expires) {
      f.status = "expired";
      return;
    }
    this.polling = true;
    try {
      if (this.refreshing) await this.refreshing.catch(() => {});
      const r = await this.post(
        "/open-apis/authen/v2/oauth/token",
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: this.cfg.appId,
          client_secret: this.cfg.appSecret!,
          device_code: f.device_code,
        },
        true,
      );
      if (r.access_token) {
        this.user = {
          access_token: r.access_token,
          refresh_token: r.refresh_token,
          expires_at: Date.now() + (r.expires_in ?? 7200) * 1000,
          granted_scopes:
            typeof r.scope === "string" ? r.scope.split(" ") : f.scopes,
        };
        this.save();
        f.status = "authorized";
      } else if (r.error === "slow_down" || r.code === 91032) f.interval += 5;
      else if (r.error !== "authorization_pending" && r.code !== 91031)
        f.status = "denied_or_failed";
    } catch {
      /* Retry transient failures until device flow expires. */
    } finally {
      f.nextPoll = Date.now() + f.interval * 1000;
      this.polling = false;
    }
  }
  close() {
    clearInterval(this.timer);
  }
}

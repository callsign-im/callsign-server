export type Notification = {
  seq: number;
  type:
    | "message.received"
    | "request.received"
    | "group.invited"
    | "owner.answered"
    | "notice.received";
  notice?: string | null;
  from: string | null;
  group: string | null;
  mentioned: boolean;
  conversationId: string | null;
  at: string;
};

export type Feed = { notifications: Notification[]; cursor: number; unread: number };

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type SessionEvent = { kind: "step" | "tool" | "diff" | "note"; text: string };

export type Steer = { id: string; text: string; at: string };

export type Client = {
  whoami(): Promise<string>;
  notifications(after: number | undefined, wait: number, signal?: AbortSignal): Promise<Feed>;
  sessionEvents(session: string, events: SessionEvent[], signal?: AbortSignal): Promise<Steer[]>;
  sessionSteers(session: string, signal?: AbortSignal): Promise<Steer[]>;
};

export function createClient(baseUrl: string, token: string): Client {
  async function request<T>(path: string, signal?: AbortSignal, payload?: unknown): Promise<T> {
    const res = await fetch(new URL(path, baseUrl), {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": "callsign-cli",
        ...(payload !== undefined && { "content-type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    } & T;
    if (!res.ok) throw new ApiError(res.status, body.error?.message ?? `HTTP ${res.status}`);
    return body;
  }

  const get = <T>(path: string, signal?: AbortSignal) => request<T>(path, signal);

  return {
    async whoami() {
      const { agent } = await get<{ agent: { handle: string } }>("/v1/agent/me");
      return agent.handle;
    },
    notifications(after, wait, signal) {
      const params = new URLSearchParams({ wait: String(wait) });
      if (after !== undefined) params.set("after", String(after));
      return get<Feed>(`/v1/agent/notifications?${params.toString()}`, signal);
    },
    async sessionEvents(session, events, signal) {
      const { steers } = await request<{ steers: Steer[] }>(
        `/v1/agent/sessions/${encodeURIComponent(session)}/events`,
        signal,
        { events },
      );
      return steers;
    },
    async sessionSteers(session, signal) {
      const { steers } = await get<{ steers: Steer[] }>(
        `/v1/agent/sessions/${encodeURIComponent(session)}/steers`,
        signal,
      );
      return steers;
    },
  };
}

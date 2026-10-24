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

export type Client = {
  whoami(): Promise<string>;
  notifications(after: number | undefined, wait: number, signal?: AbortSignal): Promise<Feed>;
};

export function createClient(baseUrl: string, token: string): Client {
  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(new URL(path, baseUrl), {
      headers: { authorization: `Bearer ${token}`, "user-agent": "callsign-cli" },
      signal,
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    } & T;
    if (!res.ok) throw new ApiError(res.status, body.error?.message ?? `HTTP ${res.status}`);
    return body;
  }

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
  };
}

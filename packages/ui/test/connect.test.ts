import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type ProjectState } from "@inventio/schema";

vi.mock("../src/lib/api.js", () => ({
  api: { snapshot: vi.fn() },
  errorMessage: (error: unknown) => String(error),
}));

import { api } from "../src/lib/api.js";
import { connectProject } from "../src/store/connect.js";
import { useStore } from "../src/store/store.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }
}

function snapshot(seq: number): ProjectState {
  const state = initialState();
  state.slug = "version-skew";
  state.title = "Version skew";
  state.seq = seq;
  return state;
}

describe("project stream recovery", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    useStore.setState({ projects: {}, collapse: {}, toasts: [] });
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reloads an authoritative snapshot when an open browser sees a newer event type", async () => {
    const snapshotCall = vi.mocked(api.snapshot);
    snapshotCall
      .mockResolvedValueOnce({ state: snapshot(4), seq: 4 })
      .mockResolvedValueOnce({ state: snapshot(5), seq: 5 });

    const disconnect = connectProject("version-skew");
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const stale = FakeEventSource.instances[0]!;
    stale.message({
      seq: 5,
      ts: new Date(5).toISOString(),
      type: "schema.fromTheFuture",
    });

    await vi.waitFor(() => expect(snapshotCall).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));

    expect(stale.closed).toBe(true);
    expect(FakeEventSource.instances[1]!.url).toContain("since=5");
    expect(useStore.getState().projects["version-skew"]?.state?.seq).toBe(5);
    expect(useStore.getState().projects["version-skew"]?.lastError).toBeNull();
    disconnect();
  });
});

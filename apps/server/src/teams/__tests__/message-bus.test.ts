import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessageBus } from "../message-bus";
import type { TeamAgentMessage } from "@agentforge/shared-types";

const TEAM_RUN_ID = "tr-test-001";
const NOW_ISO = "2026-07-16T12:00:00.000Z";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal payload accepted by AgentMessagePayload (task variant). */
function taskPayload(task: string) {
  return { task };
}

/** Build a simple result payload. */
function resultPayload(result: unknown) {
  return { result };
}

// ---------------------------------------------------------------------------
// UUID sequence
// ---------------------------------------------------------------------------

let uuidCounter = 0;

function nextUUID(): string {
  uuidCounter += 1;
  return `uuid-${String(uuidCounter).padStart(3, "0")}`;
}

vi.mock("crypto", () => ({
  randomUUID: vi.fn(() => nextUUID()),
}));

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe("MessageBus", () => {
  let bus: MessageBus;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    uuidCounter = 0;
    bus = new MessageBus(TEAM_RUN_ID);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // send
  // =========================================================================

  describe("send", () => {
    it("returns a TeamAgentMessage with all required fields", () => {
      const msg = bus.send("agent-a", "agent-b", "task", taskPayload("review PR"));

      expect(msg).toMatchObject({
        id: "uuid-001",
        teamRunId: TEAM_RUN_ID,
        from: "agent-a",
        to: "agent-b",
        type: "task",
        payload: { task: "review PR" },
        timestamp: NOW_ISO,
      });
    });

    it("emits an event on the target agent channel", () => {
      const handler = vi.fn();
      bus.subscribe("agent-b", handler);

      bus.send("agent-a", "agent-b", "task", taskPayload("hello"));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ from: "agent-a", to: "agent-b" }),
      );
    });

    it('emits on "broadcast" channel when to="broadcast"', () => {
      // Subscribe directly on the EventEmitter "broadcast" event.
      // send(…, to="broadcast") emits on the "broadcast" channel twice:
      //   1) this.emitter.emit(to, msg)   → emit("broadcast", msg)
      //   2) if (to === "broadcast") { this.emitter.emit("broadcast", msg) }
      const broadcastHandler = vi.fn();
      bus["emitter"].on("broadcast", broadcastHandler);

      bus.send("agent-a", "broadcast", "broadcast", taskPayload("all hands"));

      expect(broadcastHandler).toHaveBeenCalledTimes(2);
      expect(broadcastHandler).toHaveBeenCalledWith(
        expect.objectContaining({ to: "broadcast", type: "broadcast" }),
      );
    });

    it('emits generic "message" event for every send', () => {
      const genericHandler = vi.fn();
      bus.subscribeAll(genericHandler);

      bus.send("agent-a", "agent-b", "task", taskPayload("msg1"));
      bus.send("agent-c", "agent-d", "result", resultPayload(42));

      expect(genericHandler).toHaveBeenCalledTimes(2);
    });

    it("produces an ISO-8601 timestamp for every message", () => {
      const msg = bus.send("a", "b", "status", { status: { completed: 0, total: 5 } });

      // Must parse as a valid date that matches our frozen time
      expect(() => new Date(msg.timestamp)).not.toThrow();
      expect(new Date(msg.timestamp).toISOString()).toBe(NOW_ISO);
    });

    it("attaches correlationId when provided", () => {
      const msg = bus.send("a", "b", "task", taskPayload("x"), "corr-42");
      expect(msg.correlationId).toBe("corr-42");
    });

    it("attaches replyTo when provided", () => {
      const msg = bus.send("a", "b", "question", { question: "why?" }, undefined, "msg-001");
      expect(msg.replyTo).toBe("msg-001");
    });

    it("omits correlationId and replyTo when not provided", () => {
      const msg = bus.send("a", "b", "done", {});
      expect(msg.correlationId).toBeUndefined();
      expect(msg.replyTo).toBeUndefined();
    });

    it("increments the internal message count", () => {
      expect(bus.count).toBe(0);
      bus.send("a", "b", "task", taskPayload("1"));
      expect(bus.count).toBe(1);
      bus.send("a", "b", "task", taskPayload("2"));
      expect(bus.count).toBe(2);
    });
  });

  // =========================================================================
  // subscribe
  // =========================================================================

  describe("subscribe", () => {
    it("calls the handler when a message is addressed to the subscribed agent", () => {
      const handler = vi.fn();
      bus.subscribe("orchestrator", handler);

      bus.send("planner", "orchestrator", "task", taskPayload("plan"));

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ from: "planner", to: "orchestrator" }),
      );
    });

    it("does NOT call the handler for messages addressed to other agents", () => {
      const handler = vi.fn();
      bus.subscribe("agent-x", handler);

      bus.send("a", "agent-y", "task", taskPayload("nope"));

      expect(handler).not.toHaveBeenCalled();
    });

    it("returns an unsubscribe function", () => {
      const handler = vi.fn();
      const unsubscribe = bus.subscribe("agent-a", handler);
      expect(typeof unsubscribe).toBe("function");
    });

    it("unsubscribe stops the handler from receiving future messages", () => {
      const handler = vi.fn();
      const unsubscribe = bus.subscribe("agent-a", handler);

      bus.send("b", "agent-a", "task", taskPayload("before unsub"));
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();

      bus.send("b", "agent-a", "task", taskPayload("after unsub"));
      expect(handler).toHaveBeenCalledTimes(1); // still 1
    });

    it("notifies all subscribers listening to the same agent", () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const h3 = vi.fn();

      bus.subscribe("agent-a", h1);
      bus.subscribe("agent-a", h2);
      bus.subscribe("agent-a", h3);

      bus.send("b", "agent-a", "task", taskPayload("multi"));

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
      expect(h3).toHaveBeenCalledTimes(1);
    });

    it("does not interfere with subscribers of other agents after unsubscribe", () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const unsub = bus.subscribe("agent-a", h1);
      bus.subscribe("agent-b", h2);

      unsub();

      bus.send("x", "agent-a", "task", taskPayload("a-only"));
      bus.send("x", "agent-b", "task", taskPayload("b-only"));

      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // subscribeAll
  // =========================================================================

  describe("subscribeAll", () => {
    it("calls the handler for every message regardless of target", () => {
      const handler = vi.fn();
      bus.subscribeAll(handler);

      bus.send("a", "b", "task", taskPayload("1"));
      bus.send("c", "d", "result", resultPayload("done"));
      bus.send("e", "broadcast", "broadcast", taskPayload("all"));

      expect(handler).toHaveBeenCalledTimes(3);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ from: "a", to: "b" }),
      );
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ from: "c", to: "d" }),
      );
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ from: "e", to: "broadcast" }),
      );
    });

    it("returns an unsubscribe function", () => {
      const handler = vi.fn();
      const unsub = bus.subscribeAll(handler);
      expect(typeof unsub).toBe("function");

      unsub();
      bus.send("a", "b", "task", taskPayload("post-unsub"));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // waitFor
  // =========================================================================

  describe("waitFor", () => {
    it("resolves when a message is sent to the specified agent", async () => {
      // waitFor subscribes on the agentName channel; send emits on the `to`
      // channel, so waitFor("agent-z") fires when someone sends TO agent-z.
      const promise = bus.waitFor("agent-z");

      bus.send("sender", "agent-z", "result", resultPayload("ok"));

      // flush microtasks so the promise settles
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toMatchObject({
        from: "sender",
        to: "agent-z",
        type: "result",
        payload: { result: "ok" },
      });
    });

    it("resolves with the first matching message (subsequent messages are ignored)", async () => {
      const promise = bus.waitFor("agent-z");

      bus.send("sender1", "agent-z", "task", taskPayload("first"));
      bus.send("sender2", "agent-z", "task", taskPayload("second"));

      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result.payload).toEqual({ task: "first" });
    });

    it("rejects after timeoutMs when no matching message arrives", async () => {
      const promise = bus.waitFor("never-sent", 500);
      let rejectionError: Error | undefined;
      promise.catch((e: Error) => {
        rejectionError = e;
      });

      await vi.advanceTimersByTimeAsync(501);

      expect(rejectionError).toBeDefined();
      expect(rejectionError!.message).toBe(
        "Timeout waiting for message from never-sent after 500ms",
      );
    });

    it("does not resolve when a different agent receives a message", async () => {
      const promise = bus.waitFor("target", 500);
      let rejectionError: Error | undefined;
      promise.catch((e: Error) => {
        rejectionError = e;
      });

      // Send to someone else — does not trigger waitFor("target")
      bus.send("other-agent", "someone-else", "task", taskPayload("nope"));

      await vi.advanceTimersByTimeAsync(501);

      expect(rejectionError).toBeDefined();
      expect(rejectionError!.message).toMatch(/Timeout/);
    });

    it("cleans up the timer when the message arrives before timeout", async () => {
      const promise = bus.waitFor("fast", 1000);

      // Send a message TO "fast" before the timeout fires
      bus.send("sender", "fast", "done", {});

      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result.to).toBe("fast");
      expect(result.from).toBe("sender");
    });

    it("uses the default timeout of 120000ms when not specified", async () => {
      const promise = bus.waitFor("no-show");
      let rejectionError: Error | undefined;
      promise.catch((e: Error) => {
        rejectionError = e;
      });

      await vi.advanceTimersByTimeAsync(120_001);

      expect(rejectionError).toBeDefined();
      expect(rejectionError!.message).toContain("120000ms");
    });
  });

  // =========================================================================
  // waitForType
  // =========================================================================

  describe("waitForType", () => {
    it("resolves when a message of the specified type arrives", async () => {
      const promise = bus.waitForType("handoff");

      bus.send("a", "b", "task", taskPayload("not this"));
      bus.send("c", "d", "handoff", { context: { next: "e" } });

      await expect(promise).resolves.toMatchObject({
        from: "c",
        to: "d",
        type: "handoff",
        payload: { context: { next: "e" } },
      });
    });

    it("ignores messages of the wrong type", async () => {
      const promise = bus.waitForType("done", 500);
      let rejectionError: Error | undefined;
      promise.catch((e: Error) => {
        rejectionError = e;
      });

      bus.send("x", "y", "task", taskPayload("1"));
      bus.send("x", "y", "status", { status: { completed: 1, total: 3 } });
      bus.send("x", "y", "error", {
        error: { message: "boom", recoverable: false },
      });

      await vi.advanceTimersByTimeAsync(501);

      expect(rejectionError).toBeDefined();
      expect(rejectionError!.message).toMatch(/Timeout/);
    });

    it("rejects after timeoutMs when no matching type arrives", async () => {
      const promise = bus.waitForType("done", 300);
      let rejectionError: Error | undefined;
      promise.catch((e: Error) => {
        rejectionError = e;
      });

      await vi.advanceTimersByTimeAsync(301);

      expect(rejectionError).toBeDefined();
      expect(rejectionError!.message).toBe(
        "Timeout waiting for message type done after 300ms",
      );
    });
  });

  // =========================================================================
  // getHistory
  // =========================================================================

  describe("getHistory", () => {
    it("returns an empty array initially", () => {
      expect(bus.getHistory()).toEqual([]);
    });

    it("returns all messages in insertion order", () => {
      bus.send("a", "b", "task", taskPayload("1"));
      bus.send("b", "c", "result", resultPayload("ok"));
      bus.send("c", "a", "feedback", {
        feedback: {
          verdict: "pass",
          score: 10,
          issues: [],
          summary: "good",
        },
      });

      const history = bus.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0].payload).toEqual({ task: "1" });
      expect(history[1].payload).toEqual({ result: "ok" });
      expect(history[2].type).toBe("feedback");
    });

    it("returns a copy, not a reference to internal state", () => {
      bus.send("a", "b", "task", taskPayload("original"));

      const history1 = bus.getHistory();
      history1.push({} as TeamAgentMessage); // mutate the copy

      const history2 = bus.getHistory();
      expect(history2).toHaveLength(1);
    });
  });

  // =========================================================================
  // getConversation
  // =========================================================================

  describe("getConversation", () => {
    it("returns messages between two agents in both directions", () => {
      bus.send("alice", "bob", "task", taskPayload("task from alice"));
      bus.send("bob", "alice", "result", resultPayload("response from bob"));
      bus.send("charlie", "dave", "task", taskPayload("unrelated"));

      const conv = bus.getConversation("alice", "bob");
      expect(conv).toHaveLength(2);
      expect(conv[0].from).toBe("alice");
      expect(conv[0].to).toBe("bob");
      expect(conv[1].from).toBe("bob");
      expect(conv[1].to).toBe("alice");
    });

    it("excludes messages that involve only one of the two agents", () => {
      bus.send("alice", "bob", "task", taskPayload("a->b"));
      bus.send("alice", "charlie", "task", taskPayload("a->c"));

      const conv = bus.getConversation("alice", "bob");
      expect(conv).toHaveLength(1);
      expect(conv[0].to).toBe("bob");
    });

    it("returns an empty array when no conversation exists", () => {
      expect(bus.getConversation("alice", "bob")).toEqual([]);
    });
  });

  // =========================================================================
  // getByCorrelation
  // =========================================================================

  describe("getByCorrelation", () => {
    it("returns messages with a matching correlationId", () => {
      bus.send("a", "b", "task", taskPayload("1"), "corr-abc");
      bus.send("b", "a", "result", resultPayload("ok"), "corr-abc");
      bus.send("c", "d", "task", taskPayload("2"), "corr-xyz");

      const group = bus.getByCorrelation("corr-abc");
      expect(group).toHaveLength(2);
      expect(group[0].correlationId).toBe("corr-abc");
      expect(group[1].correlationId).toBe("corr-abc");
    });

    it("returns an empty array when no messages match", () => {
      bus.send("a", "b", "task", taskPayload("1"), "corr-abc");
      expect(bus.getByCorrelation("nonexistent")).toEqual([]);
    });

    it("returns an empty array when there are no messages", () => {
      expect(bus.getByCorrelation("anything")).toEqual([]);
    });
  });

  // =========================================================================
  // getRecent
  // =========================================================================

  describe("getRecent", () => {
    it("returns the last N messages", () => {
      for (let i = 0; i < 5; i++) {
        bus.send("a", "b", "task", taskPayload(`msg-${i}`));
      }

      const recent = bus.getRecent(3);
      expect(recent).toHaveLength(3);
      expect(recent[0].payload).toEqual({ task: "msg-2" });
      expect(recent[1].payload).toEqual({ task: "msg-3" });
      expect(recent[2].payload).toEqual({ task: "msg-4" });
    });

    it("returns all messages when count is fewer than N", () => {
      bus.send("a", "b", "task", taskPayload("only"));

      const recent = bus.getRecent(5);
      expect(recent).toHaveLength(1);
    });

    it("defaults to 10 when no argument is provided", () => {
      // The implementation uses slice(-count) and count defaults to 10.
      // We verify the default by calling without arguments.
      for (let i = 0; i < 15; i++) {
        bus.send("a", "b", "task", taskPayload(`msg-${i}`));
      }

      const recent = bus.getRecent(); // default count = 10
      expect(recent).toHaveLength(10);
    });

    it("returns an empty array when there are no messages", () => {
      expect(bus.getRecent()).toEqual([]);
    });
  });

  // =========================================================================
  // clear
  // =========================================================================

  describe("clear", () => {
    it("removes all messages (count becomes 0)", () => {
      bus.send("a", "b", "task", taskPayload("1"));
      bus.send("c", "d", "result", resultPayload("2"));

      expect(bus.count).toBe(2);

      bus.clear();

      expect(bus.count).toBe(0);
      expect(bus.getHistory()).toEqual([]);
    });

    it("removes all event listeners", () => {
      const handler = vi.fn();
      bus.subscribe("agent-a", handler);
      bus.subscribeAll(vi.fn());

      bus.clear();

      // After clear, new messages should not trigger old handlers
      bus.send("x", "agent-a", "task", taskPayload("post-clear"));
      expect(handler).not.toHaveBeenCalled();
    });

    it("is idempotent (calling clear on an empty bus does not throw)", () => {
      expect(() => bus.clear()).not.toThrow();
      expect(() => bus.clear()).not.toThrow(); // second call
    });
  });

  // =========================================================================
  // count
  // =========================================================================

  describe("count", () => {
    it("starts at 0", () => {
      expect(bus.count).toBe(0);
    });

    it("increments after each send", () => {
      bus.send("a", "b", "task", taskPayload("1"));
      expect(bus.count).toBe(1);

      bus.send("a", "b", "result", resultPayload("2"));
      expect(bus.count).toBe(2);

      bus.send("a", "b", "done", {});
      expect(bus.count).toBe(3);
    });
  });

  // =========================================================================
  // serialize
  // =========================================================================

  describe("serialize", () => {
    it("returns the messages array for DB persistence", () => {
      bus.send("a", "b", "task", taskPayload("m1"));
      bus.send("c", "d", "result", resultPayload("m2"));

      const serialized = bus.serialize();

      expect(serialized).toHaveLength(2);
      expect(serialized[0]).toMatchObject({
        id: "uuid-001",
        from: "a",
        to: "b",
      });
      expect(serialized[1]).toMatchObject({
        id: "uuid-002",
        from: "c",
        to: "d",
      });
    });

    it("returns an empty array when no messages have been sent", () => {
      expect(bus.serialize()).toEqual([]);
    });
  });
});

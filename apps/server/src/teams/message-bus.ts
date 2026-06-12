// MessageBus — in-memory event-driven message bus for Multi-Agent communication
// Messages are persisted to agent_team_runs.messages JSONB for recovery and auditing
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import type { TeamAgentMessage, AgentMessageType, AgentMessagePayload } from "@agentforge/shared-types";

export class MessageBus {
  private emitter: EventEmitter;
  private messages: TeamAgentMessage[] = [];
  private teamRunId: string;

  constructor(teamRunId: string) {
    this.teamRunId = teamRunId;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(50); // Allow many listeners for multi-agent
  }

  /** Send a message */
  send(from: string, to: string, type: AgentMessageType, payload: AgentMessagePayload, correlationId?: string, replyTo?: string): TeamAgentMessage {
    const msg: TeamAgentMessage = {
      id: randomUUID(),
      teamRunId: this.teamRunId,
      from,
      to,
      type,
      payload,
      timestamp: new Date().toISOString(),
      replyTo,
      correlationId,
    };

    this.messages.push(msg);

    // Notify subscribers
    this.emitter.emit(to, msg);
    if (to === "broadcast") {
      this.emitter.emit("broadcast", msg);
    }
    // Also emit generic "message" event for logging/frontend
    this.emitter.emit("message", msg);

    return msg;
  }

  /** Subscribe to messages for a specific agent */
  subscribe(agentName: string, handler: (msg: TeamAgentMessage) => void): () => void {
    this.emitter.on(agentName, handler);
    return () => {
      this.emitter.off(agentName, handler);
    };
  }

  /** Subscribe to all messages */
  subscribeAll(handler: (msg: TeamAgentMessage) => void): () => void {
    this.emitter.on("message", handler);
    return () => {
      this.emitter.off("message", handler);
    };
  }

  /** Wait for a message from a specific agent (Promise-based) */
  waitFor(from: string, timeoutMs: number = 120000): Promise<TeamAgentMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout waiting for message from ${from} after ${timeoutMs}ms`));
      }, timeoutMs);

      const unsubscribe = this.subscribe(from, (msg) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(msg);
      });
    });
  }

  /** Wait for any message of a specific type */
  waitForType(type: AgentMessageType, timeoutMs: number = 120000): Promise<TeamAgentMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout waiting for message type ${type} after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (msg: TeamAgentMessage) => {
        if (msg.type === type) {
          clearTimeout(timer);
          unsubscribe();
          resolve(msg);
        }
      };

      const unsubscribe = this.subscribeAll(handler);
    });
  }

  /** Get all messages in order */
  getHistory(): TeamAgentMessage[] {
    return [...this.messages];
  }

  /** Get messages between two agents */
  getConversation(agentA: string, agentB: string): TeamAgentMessage[] {
    return this.messages.filter(
      (m) =>
        (m.from === agentA && m.to === agentB) ||
        (m.from === agentB && m.to === agentA),
    );
  }

  /** Get messages by correlation ID */
  getByCorrelation(correlationId: string): TeamAgentMessage[] {
    return this.messages.filter((m) => m.correlationId === correlationId);
  }

  /** Get the latest N messages */
  getRecent(count: number = 10): TeamAgentMessage[] {
    return this.messages.slice(-count);
  }

  /** Clear all messages (for cleanup) */
  clear(): void {
    this.messages = [];
    this.emitter.removeAllListeners();
  }

  /** Get the message count */
  get count(): number {
    return this.messages.length;
  }

  /** Serialize messages for DB persistence */
  serialize(): object[] {
    return this.messages;
  }
}

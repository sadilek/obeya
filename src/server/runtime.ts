// Agent sessions behind a small interface, so the orchestration can be tested without a model.

import { createSdkMcpServer, type PermissionMode, query, type SDKUserMessage, tool } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { mediaType } from './images';

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  /** Returns the text the agent sees as the tool result. */
  run: (args: Record<string, unknown>) => Promise<string> | string;
}

export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  /**
   * The turn ended; the session waits for the next message. `background` counts the agent's
   * background tasks still running: when one ends, the session wakes itself for a new turn.
   */
  | { type: 'idle'; background?: number }
  | { type: 'error'; message: string };

export interface AgentSpec {
  cwd: string;
  /** Appended to the default system prompt. */
  system: string;
  /** Tools the agent reaches as `mcp__obeya__<name>`. */
  tools: AgentTool[];
  /** Resume this session instead of starting one. */
  resume?: string;
  /** Read-only agents get no tools that change files or run commands. */
  readOnly?: boolean;
  permissionMode?: PermissionMode;
  /** How much the model thinks; low for quick turns such as reading a spoken command. */
  effort?: 'low' | 'medium' | 'high';
  onEvent: (e: AgentEvent) => void;
}

export interface AgentSession {
  /** Sends a user message, with images (files) after the text; the session takes it at the next opportunity. */
  send(text: string, images?: string[]): void;
  /** Ends the session after the current step. */
  close(): void;
  /** Settles when the session has ended. */
  done: Promise<void>;
}

export interface AgentRuntime {
  /** Without a first message the agent starts up and waits, so a later `send` skips the start-up. */
  start(spec: AgentSpec, firstMessage?: string, images?: string[]): AgentSession;
}

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

/** Runs agents through the Claude Agent SDK, on the Claude Code login of the machine. */
export const sdkRuntime: AgentRuntime = {
  start(spec, firstMessage, images) {
    const inbox = new Inbox();
    if (firstMessage !== undefined) inbox.push(firstMessage, images);
    const abort = new AbortController();
    const obeya = createSdkMcpServer({
      name: 'obeya',
      version: '1.0.0',
      // the agent needs these from the first step, not behind a tool search
      alwaysLoad: true,
      tools: spec.tools.map((t) =>
        tool(t.name, t.description, t.schema, async (args) => ({ content: [{ type: 'text' as const, text: await t.run(args as Record<string, unknown>) }] })),
      ),
    });
    const ownTools = spec.tools.map((t) => `mcp__obeya__${t.name}`);
    const q = query({
      prompt: inbox,
      options: {
        cwd: spec.cwd,
        abortController: abort,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.system },
        mcpServers: { obeya },
        ...(spec.readOnly
          ? { tools: READ_ONLY_TOOLS, allowedTools: [...READ_ONLY_TOOLS, ...ownTools], permissionMode: 'dontAsk' as const }
          : { allowedTools: ownTools, permissionMode: spec.permissionMode ?? 'auto' }),
        ...(spec.resume ? { resume: spec.resume } : {}),
        ...(spec.effort ? { effort: spec.effort } : {}),
        env: cleanEnv(),
      },
    });
    // the agent's background tasks (a render, a test run); watchers that are no activity don't count
    let background = 0;
    const done = (async () => {
      try {
        for await (const m of q) {
          if (m.type === 'system' && m.subtype === 'init') spec.onEvent({ type: 'session', id: m.session_id });
          else if (m.type === 'system' && m.subtype === 'background_tasks_changed') background = m.tasks.filter((t) => !t.ambient).length;
          else if (m.type === 'assistant' && !m.parent_tool_use_id) {
            for (const block of m.message.content) {
              if (block.type === 'text' && block.text.trim()) spec.onEvent({ type: 'text', text: block.text });
              else if (block.type === 'tool_use') spec.onEvent({ type: 'tool', name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
            }
          } else if (m.type === 'result') {
            if (m.subtype !== 'success') spec.onEvent({ type: 'error', message: m.subtype });
            spec.onEvent({ type: 'idle', background });
          }
        }
      } catch (e) {
        if (!abort.signal.aborted) spec.onEvent({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return {
      send: (text, images) => inbox.push(text, images),
      close: () => {
        inbox.end();
        abort.abort();
      },
      done,
    };
  },
};

/** Obeya's own environment minus what belongs to a Claude Code session that may have started it. */
function cleanEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$)/.test(k)));
}

/** The session's input: an async stream of user messages that stays open until ended. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage['message']['content'][] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(text: string, images: string[] = []) {
    // read now: the files may be gone by the time the session takes the message
    this.queue.push(
      images.length
        ? [
            { type: 'text', text },
            ...images.map((f) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType(f), data: readFileSync(f).toString('base64') } })),
          ]
        : text,
    );
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      while (this.queue.length) yield { type: 'user', message: { role: 'user', content: this.queue.shift()! }, parent_tool_use_id: null };
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

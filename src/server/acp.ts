// Agents that speak the Agent Client Protocol (ACP, https://agentclientprotocol.com): a process per
// session, JSON-RPC 2.0 over its stdio, one JSON message per line. What any ACP agent shares lives
// here, apart from what one agent makes of it (gemini.ts for Antigravity's `agy acp`): the
// connection, the content of a prompt, the updates a session sends, and Obeya's tools as an MCP
// server over HTTP on the loopback, which an ACP session takes with `session/new` and again with
// each `session/load` or `session/resume`, so a resumed session has the tools as they are now.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import { messageOf } from '../core/text';
import { endTree, spawnOptions, startArgv } from './codex';
import { type AgentTool, stderrTail, trackHere, withStderr } from './runtime';
import { OWN_GROUP } from './spawn';

type Env = Record<string, string | undefined>;

/** A failure the agent reported for a request: its JSON-RPC error. */
export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** The message a request to an agent whose process has ended fails with. */
const ENDED = 'the ACP agent ended';

/**
 * An ACP agent's process and the JSON-RPC connection over its stdio: requests out and their
 * answers, notifications in (`session/update`), and the agent's own requests (a permission to ask
 * for), answered by `onRequest`.
 */
export class AcpConnection {
  private proc: ChildProcess;
  private next = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private dead = false;
  stderr = '';
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {};
  onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown> = async (method) => {
    throw new AcpError(`${method} is not handled`, -32601);
  };
  /** Settles with the exit code once the process has ended. */
  readonly exited: Promise<number | null>;

  constructor(o: { bin: string; args: string[]; cwd: string; env: Env }) {
    const argv = startArgv(o.bin, o.args);
    const p = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: OWN_GROUP, ...spawnOptions(argv) });
    trackHere(p);
    this.proc = p;
    this.exited = new Promise((resolve) => {
      p.once('error', (e: Error) => ((this.stderr += e.message), resolve(null)));
      p.once('close', (code: number | null) => resolve(code));
    });
    void this.exited.then(() => {
      this.dead = true;
      for (const q of this.pending.values()) q.reject(new AcpError(withStderr(ENDED, this.stderr)));
      this.pending.clear();
    });
    p.stdout!.setEncoding('utf8').on('data', (d: string) => this.take(d));
    p.stderr!.setEncoding('utf8').on('data', (d: string) => (this.stderr = stderrTail(this.stderr, d)));
    // a closed pipe as the process ends is no error of Obeya's
    p.stdin!.on('error', () => {});
  }

  /** Initializes the connection: Obeya reads and writes no files for the agent and gives it no terminal of its own. */
  initialize(): Promise<AcpInitialized> {
    return this.request<AcpInitialized>('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'obeya', title: 'Obeya', version: '1' } });
  }

  request<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
    if (this.dead) return Promise.reject(new AcpError(withStderr(ENDED, this.stderr)));
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** Ends the process, and what it runs. */
  close() {
    endTree(this.proc);
  }

  private write(m: unknown) {
    if (this.proc.stdin!.writable) this.proc.stdin!.write(`${JSON.stringify(m)}\n`);
  }

  private take(data: string) {
    this.buffer += data;
    let n: number;
    while ((n = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, n).trim();
      this.buffer = this.buffer.slice(n + 1);
      if (!line) continue;
      let m: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; code?: number; data?: unknown } };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.method && m.id !== undefined) void this.answer(m.id, m.method, m.params ?? {});
      else if (m.method) this.onNotification(m.method, m.params ?? {});
      else if (typeof m.id === 'number') {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new AcpError(acpMessage(m.error), m.error.code, m.error.data));
        else p?.resolve(m.result);
      }
    }
  }

  private async answer(id: number | string, method: string, params: Record<string, unknown>) {
    try {
      this.write({ jsonrpc: '2.0', id, result: (await this.onRequest(method, params)) ?? null });
    } catch (e) {
      this.write({ jsonrpc: '2.0', id, error: { code: e instanceof AcpError && e.code ? e.code : -32603, message: messageOf(e) } });
    }
  }
}

/** An error's words, with what its data says beside a generic message ("Internal error"). */
function acpMessage(e: { message?: string; data?: unknown }): string {
  const message = e.message ?? 'error';
  const data = typeof e.data === 'string' ? e.data : e.data && typeof e.data === 'object' && 'message' in e.data ? String((e.data as { message: unknown }).message) : '';
  return data && !message.includes(data) ? `${message}: ${data}` : message;
}

/** What `initialize` answers; only what Obeya reads of it. */
export interface AcpInitialized {
  protocolVersion?: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } };
}

/** A model as a session offers it (`session/new`'s `models.availableModels`). */
export interface AcpModel {
  modelId: string;
  name?: string;
}

/** What `session/new`, `session/load` and `session/resume` answer; only what Obeya reads of it. */
export interface AcpSessionOpened {
  sessionId?: string;
  models?: { availableModels?: AcpModel[]; currentModelId?: string };
  configOptions?: { id: string; currentValue?: string; options?: { value: string; name?: string }[] }[];
}

/** A turn's tokens, as an ACP agent reports them with `session/prompt`'s answer (`usage`). */
export interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

/** A tool call as `session/update` (`tool_call`, `tool_call_update`) and `session/request_permission` report it. */
export interface AcpToolCall {
  toolCallId: string;
  /** The agent's own name for the tool, where it gives one (an extension of Antigravity's). */
  name?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  locations?: { path: string }[];
}

/** An option of a permission request (`session/request_permission`). */
export interface AcpPermissionOption {
  optionId: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
  name?: string;
}

/** The answer to a permission request that picks the first option of `kind`, else cancels it. */
export function pickPermission(options: AcpPermissionOption[], kind: 'allow_once' | 'reject_once') {
  const option = options.find((o) => o.kind === kind) ?? options.find((o) => o.kind.startsWith(kind.split('_')[0]!));
  return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
}

/** The image types an ACP prompt takes by their file names; others go as they are. */
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** A user message as an ACP prompt: its text, then its images (files on this machine), each read in. */
export async function promptOf(text: string, images: string[] = []): Promise<unknown[]> {
  const read = await Promise.all(
    images.map(async (path): Promise<unknown> => {
      try {
        return { type: 'image', mimeType: IMAGE_TYPES[extname(path).toLowerCase()] ?? 'image/png', data: (await readFile(path)).toString('base64') };
      } catch {
        return { type: 'text', text: `(An image Obeya could not read: ${path})` };
      }
    }),
  );
  return [{ type: 'text', text }, ...read];
}

/** A tool's input schema as JSON Schema, as MCP lists it. */
function inputSchema(shape: z.ZodRawShape): unknown {
  const { $schema: _, ...schema } = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  return schema;
}

/** One session's tools on the server: called as `run` returns; `after` is read after each call, `onCall` told of each. */
interface Served {
  tools: AgentTool[];
  after?: () => string | undefined;
}

/**
 * Obeya's tools as MCP servers over streamable HTTP on the loopback, one path per session with a
 * token of its own (`open`), which only that session's agent knows. JSON answers only, no events
 * stream: every call is answered as it is done. The server starts with the first session and stays.
 */
export class McpToolServer {
  private sessions = new Map<string, Served>();
  private server: ReturnType<typeof Bun.serve> | undefined;

  /** Serves `tools` at a path of their own; the URL to give the session, and how to stop serving them. */
  open(served: Served): { url: string; close: () => void } {
    const token = randomBytes(18).toString('base64url');
    this.sessions.set(token, served);
    const port = this.start().port;
    return { url: `http://127.0.0.1:${port}/mcp/${token}`, close: () => this.sessions.delete(token) };
  }

  private start() {
    this.server ??= Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      // a tool's call (a question to the owner) may take as long as the owner does
      idleTimeout: 0,
      fetch: (req) => this.serve(req),
    });
    return this.server;
  }

  private async serve(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const s = path.startsWith('/mcp/') ? this.sessions.get(path.slice(5)) : undefined;
    if (!s) return new Response('', { status: 404 });
    if (req.method === 'DELETE') return new Response(null, { status: 200 });
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    let m: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      m = await req.json();
    } catch {
      return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON' } }, { status: 400 });
    }
    // closed while the request came in: the path opens nothing any more
    if (this.sessions.get(path.slice(5)) !== s) return new Response('', { status: 404 });
    // a notification (`notifications/initialized`) needs no answer
    if (m.id === undefined || m.id === null) return new Response(null, { status: 202 });
    const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize':
        return ok({ protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'obeya', version: '1' } });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: s.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.schema) })) });
      case 'tools/call': {
        const name = m.params?.name;
        const tool = s.tools.find((t) => t.name === name);
        if (!tool) return ok({ content: [{ type: 'text', text: `No tool ${String(name)} here.` }], isError: true });
        // checked against the tool's schema, as Claude Code's tools are
        const args = z.object(tool.schema).safeParse(m.params?.arguments ?? {});
        if (!args.success) return ok({ content: [{ type: 'text', text: `Invalid arguments for ${tool.name}: ${z.prettifyError(args.error)}` }], isError: true });
        let text: string;
        let isError = false;
        try {
          text = await tool.run(args.data as Record<string, unknown>);
        } catch (e) {
          text = messageOf(e);
          isError = true;
        }
        // what changed meanwhile goes with the result, as Claude Code's agent reads it
        const update = s.after?.();
        return ok({ content: [{ type: 'text', text: update ? `${text}\n\n${update}` : text }], isError });
      }
      default:
        return Response.json({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `${String(m.method)} is not supported` } });
    }
  }
}

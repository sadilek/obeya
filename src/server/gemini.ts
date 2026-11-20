// SPIKE (throwaway): Gemini through Antigravity's `agy acp`, the Agent Client Protocol over stdio.
// One `agy acp` process per session; Obeya's tools reach it as an MCP server over HTTP on the
// loopback, one path per session with a token of its own. Every message both ways is logged to
// `$OBEYA_AGY_LOG` (a JSONL file) when set, for the spike's report.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { messageOf } from '../core/text';
import type { AgentEffort } from '../core/agents';
import { type AgentEvent, type AgentRuntime, type AgentSession, type AgentSpec, type AgentTool, cleanEnv } from './runtime';

export const GEMINI_SESSION = 'gemini:';

const log = (dir: string, m: unknown) => {
  const file = process.env.OBEYA_AGY_LOG;
  if (file) appendFileSync(file, `${JSON.stringify({ t: Date.now(), dir, m })}\n`);
};

// ---- Obeya's tools as an MCP server (streamable HTTP, JSON answers only) ----

const sessions = new Map<string, { tools: AgentTool[]; contextUpdate?: () => string | undefined; onCall: (name: string, input: Record<string, unknown>) => void }>();
let server: ReturnType<typeof Bun.serve> | undefined;

function jsonSchema(shape: z.ZodRawShape): unknown {
  const { $schema: _, ...schema } = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  return schema;
}

function mcpServer() {
  server ??= Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const token = new URL(req.url).pathname.split('/').pop() ?? '';
      const s = sessions.get(token);
      if (!s) return new Response('unknown session', { status: 404 });
      if (req.method !== 'POST') return new Response(null, { status: 405 });
      const m = (await req.json()) as { id?: number | string; method: string; params?: any };
      log('mcp-in', m);
      if (m.id === undefined) return new Response(null, { status: 202 });
      const ok = (result: unknown) => {
        log('mcp-out', { id: m.id, result });
        return Response.json({ jsonrpc: '2.0', id: m.id, result });
      };
      switch (m.method) {
        case 'initialize':
          return ok({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'obeya', version: '0' } });
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: s.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: jsonSchema(t.schema) })) });
        case 'tools/call': {
          const tool = s.tools.find((t) => t.name === m.params?.name);
          if (!tool) return ok({ content: [{ type: 'text', text: `No tool ${m.params?.name} here.` }], isError: true });
          const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
          s.onCall(tool.name, args);
          let text: string;
          let isError = false;
          try {
            text = await tool.run(args);
          } catch (e) {
            text = messageOf(e);
            isError = true;
          }
          const update = s.contextUpdate?.();
          return ok({ content: [{ type: 'text', text: update ? `${text}\n\n${update}` : text }], isError });
        }
        default:
          return Response.json({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `${m.method} not supported` } });
      }
    },
  });
  return server;
}

// ---- the session ----

/** Obeya's model families on Gemini, as agy's `model` option names them. */
const FAMILIES: Record<string, string> = { neon: 'gemini-4-neon', argon: 'gemini-4-argon', hydrogen: 'gemini-4-hydrogen', flash: 'gemini-3.8-flash' };
const THOUGHT: Record<AgentEffort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };

/** An agy tool call as Obeya's conversation shows it: in Claude Code's names where there is one. */
function toolOf(name: string, args: Record<string, any>, title?: string): { name: string; input: Record<string, unknown> } {
  switch (name) {
    case 'run_command':
      return { name: 'Bash', input: { command: args.CommandLine ?? title } };
    case 'write_file':
      return { name: 'Write', input: { file_path: args.Path } };
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'edit_file':
      return { name: 'Edit', input: { file_path: args.TargetFile ?? args.Path } };
    case 'view_file':
    case 'read_file':
      return { name: 'Read', input: { file_path: args.AbsolutePath ?? args.Path } };
    case 'grep_search':
      return { name: 'Grep', input: { pattern: args.Query ?? args.Pattern } };
    case 'list_dir':
      return { name: 'Glob', input: { pattern: args.DirectoryPath } };
    default:
      return { name, input: args };
  }
}

class GeminiSession implements AgentSession {
  readonly done: Promise<void>;
  private proc: ChildProcess | undefined;
  private closed = false;
  private id: string | undefined;
  private queue: { text: string; images?: string[] }[] = [];
  private inTurn = false;
  private text = '';
  private seen = new Set<string>();
  private next = 1;
  private pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  private token = randomBytes(16).toString('hex');
  private stderr = '';
  private tokens = 0;

  constructor(
    private spec: AgentSpec,
    firstMessage: string | undefined,
    images: string[] | undefined,
  ) {
    if (firstMessage !== undefined) this.queue.push({ text: firstMessage, images });
    this.done = this.run().catch((e) => {
      if (!this.closed) this.emit({ type: 'error', message: `${messageOf(e)}${this.stderr ? `\n${this.stderr.slice(-800)}` : ''}` });
      this.proc?.kill();
    });
  }

  send(text: string, images?: string[]) {
    if (this.closed) return;
    this.queue.push({ text, images });
    this.pump();
  }

  close() {
    this.closed = true;
    this.queue = [];
    if (this.id) this.call('session/close', { sessionId: this.id }).catch(() => {});
    setTimeout(() => this.proc?.kill(), 2000);
    sessions.delete(this.token);
  }

  private emit(e: AgentEvent) {
    this.spec.onEvent(e);
  }

  private write(m: unknown) {
    log('out', m);
    this.proc?.stdin?.write(`${JSON.stringify(m)}\n`);
  }

  private call<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.next++;
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private async run() {
    const spec = this.spec;
    sessions.set(this.token, {
      tools: spec.tools,
      contextUpdate: spec.contextUpdate,
      onCall: () => {},
    });
    const url = `http://127.0.0.1:${mcpServer().port}/mcp/${this.token}`;
    const proc = (this.proc = spawn('agy', ['acp'], { cwd: spec.cwd, env: { ...cleanEnv(), ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] }));
    proc.stderr!.on('data', (d) => (this.stderr = (this.stderr + String(d)).slice(-4000)));
    let buf = '';
    proc.stdout!.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.heard(JSON.parse(line));
      }
    });
    const exited = new Promise<number | null>((r) => proc.once('exit', r));
    await this.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const mcpServers = spec.tools.length ? [{ type: 'http', name: 'obeya', url, headers: [] }] : [];
    const system = spec.systemFor?.('gemini' as never) ?? spec.system;
    const meta = { antigravity: { systemPrompt: { append: system } } };
    if (spec.resume) {
      this.id = spec.resume.replace(GEMINI_SESSION, '');
      await this.call('session/resume', { sessionId: this.id, cwd: spec.cwd, mcpServers, ...(spec.dirs?.length ? { additionalDirectories: spec.dirs } : {}), _meta: meta });
    } else {
      const r = await this.call<{ sessionId: string }>('session/new', { cwd: spec.cwd, mcpServers, ...(spec.dirs?.length ? { additionalDirectories: spec.dirs } : {}), _meta: meta });
      this.id = r.sessionId;
    }
    const family = FAMILIES[spec.model ?? 'neon'] ?? spec.model ?? FAMILIES.neon!;
    await this.call('session/set_config_option', { sessionId: this.id, configId: 'model', value: family });
    if (spec.effort) await this.call('session/set_config_option', { sessionId: this.id, configId: 'thought_level', value: THOUGHT[spec.effort] });
    await this.call('session/set_mode', { sessionId: this.id, modeId: spec.readOnly ? 'plan' : 'auto' });
    if (this.closed) return;
    this.emit({ type: 'session', id: `${GEMINI_SESSION}${this.id}`, model: `${family}-${spec.effort ? THOUGHT[spec.effort] : 'high'}`, ...(spec.effort ? { effort: spec.effort } : {}) });
    this.pump();
    const code = await exited;
    if (!this.closed) this.emit({ type: 'error', message: `agy acp ended (${code})${this.stderr ? `: ${this.stderr.slice(-800)}` : ''}` });
  }

  private flush() {
    if (this.text.trim()) this.emit({ type: 'text', text: this.text.trim() });
    this.text = '';
  }

  private pump() {
    if (!this.id || this.inTurn || this.closed || !this.queue.length) return;
    const waiting = this.queue.splice(0);
    const prompt = waiting.flatMap((m) => [
      { type: 'text', text: m.text },
      ...(m.images ?? []).map((path) => ({ type: 'image', mimeType: path.endsWith('.png') ? 'image/png' : 'image/jpeg', data: readFileSync(path).toString('base64') })),
    ]);
    this.inTurn = true;
    this.call<{ stopReason: string; usage?: { totalTokens?: number } }>('session/prompt', { sessionId: this.id, prompt }).then(
      (r) => {
        this.flush();
        this.tokens += r.usage?.totalTokens ?? 0;
        this.inTurn = false;
        if (this.closed) return;
        this.emit({ type: 'idle', background: 0, ...(this.queue.length ? { more: true } : {}) });
        this.pump();
      },
      (e) => {
        this.flush();
        this.inTurn = false;
        if (this.closed) return;
        const message = messageOf(e);
        // agy's quota errors (weekly, spend cap) end the turn; `agy -p /quota` names when each window resets
        const limited = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i.test(message);
        this.emit({ type: 'error', message, ...(limited ? { limit: {} } : {}) });
        this.emit({ type: 'idle', background: 0 });
        this.pump();
      },
    );
  }

  private heard(m: any) {
    log('in', m);
    if (m.id !== undefined && m.method) return this.asked(m);
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
      else p?.resolve(m.result);
      return;
    }
    if (m.method !== 'session/update' || this.closed) return;
    const u = m.params.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        this.text += u.content?.text ?? '';
        return;
      case 'tool_call': {
        if (this.seen.has(u.toolCallId)) return;
        this.seen.add(u.toolCallId);
        this.flush();
        const name: string = u.name ?? '';
        // Obeya's own tools come through MCP: shown by the name they have for every harness
        const mcp = /^mcp_obeya_(.+)$/.exec(name) ?? /^obeya[_/](.+)$/.exec(name);
        if (mcp) this.emit({ type: 'tool', name: `mcp__obeya__${mcp[1]}`, input: u.args ?? u.rawInput ?? {} });
        else this.emit({ type: 'tool', ...toolOf(name, u.args ?? u.rawInput ?? {}, u.title) });
        return;
      }
    }
  }

  /** agy asks before a command leaves its sandbox (auto mode): allowed, as Obeya's workers run unattended. */
  private asked(m: any) {
    if (m.method === 'session/request_permission') {
      const opts = m.params.options as { optionId: string; kind: string }[];
      const pick = opts.find((o) => o.kind === 'allow_once') ?? opts[0]!;
      this.write({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: pick.optionId } } });
      return;
    }
    this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `${m.method} not supported` } });
  }
}

export const geminiRuntime: AgentRuntime = {
  start: (spec, firstMessage, images) => new GeminiSession(spec, firstMessage, images),
};

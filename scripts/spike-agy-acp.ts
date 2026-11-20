// Spike: talks the Agent Client Protocol to `agy acp` and logs every message, to answer what Obeya's
// runtime would need (hooks, limits, MCP tools after resume, instructions, usage). Throwaway.
//
// bun scripts/spike-agy-acp.ts <cwd> <log.jsonl> <step…>
// steps: init | new[:mode] | load:<id> | resume:<id> | prompt:<text> | mode:<id> | model:<id> | close
// A step `mcp` before `new` hands the session an HTTP MCP server at $SPIKE_MCP_URL.

import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const [cwd, logFile, ...steps] = process.argv.slice(2);
writeFileSync(logFile!, '');
const log = (dir: string, m: unknown) => appendFileSync(logFile!, `${JSON.stringify({ t: Date.now(), dir, m })}\n`);

const p = spawn('agy', ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
p.stderr.on('data', (d) => log('stderr', String(d)));
let buf = '';
let nextId = 1;
const pending = new Map<number, (r: any) => void>();
const permission = process.env.SPIKE_PERMISSION ?? 'allow';
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    log('in', m);
    if (m.id !== undefined && m.method) {
      // a request of the agent's: answer permission requests, refuse everything else
      if (m.method === 'session/request_permission') {
        const opts = m.params.options as { optionId: string; kind: string }[];
        const pick = opts.find((o) => o.kind === (permission === 'allow' ? 'allow_once' : 'reject_once')) ?? opts[0]!;
        reply(m.id, { outcome: { outcome: 'selected', optionId: pick.optionId } });
      } else reply(m.id, undefined, { code: -32601, message: 'not supported' });
    } else if (m.id !== undefined) pending.get(m.id)?.(m);
    else if (m.method === 'session/update') {
      const u = m.params.update;
      if (u.sessionUpdate === 'agent_message_chunk') process.stdout.write(u.content?.text ?? '');
      else console.log(`\n[${u.sessionUpdate}] ${JSON.stringify(u).slice(0, 300)}`);
    }
  }
});
function reply(id: number, result: unknown, error?: unknown) {
  const m = { jsonrpc: '2.0', id, ...(error ? { error } : { result }) };
  log('out', m);
  p.stdin.write(`${JSON.stringify(m)}\n`);
}
function call(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  const m = { jsonrpc: '2.0', id, method, params };
  log('out', m);
  p.stdin.write(`${JSON.stringify(m)}\n`);
  return new Promise((r) => pending.set(id, r));
}

let session = '';
// SPIKE_MCP=1: an MCP server of our own with one tool, `secret_word`, which logs each call
let mcpUrl = process.env.SPIKE_MCP_URL;
if (process.env.SPIKE_MCP) {
  const srv = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const m = (await req.json()) as any;
      log('mcp', m);
      if (m.id === undefined) return new Response(null, { status: 202 });
      const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: m.id, result });
      if (m.method === 'initialize') return ok({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'obeya', version: '0' } });
      if (m.method === 'tools/list') return ok({ tools: [{ name: 'secret_word', description: 'Returns the secret word of this session.', inputSchema: { type: 'object', properties: {} } }] });
      if (m.method === 'tools/call') { console.log(`\n[MCP CALL] ${m.params.name}`); return ok({ content: [{ type: 'text', text: 'PAPAYA' }] }); }
      return Response.json({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });
    },
  });
  mcpUrl = `http://127.0.0.1:${srv.port}/mcp`;
}
const mcp = mcpUrl ? [{ type: 'http', name: 'obeya', url: mcpUrl, headers: [] }] : [];
for (const step of steps) {
  const [what, ...rest] = step.split(':');
  const arg = rest.join(':');
  const t0 = Date.now();
  let r: any;
  if (what === 'init') r = await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  else if (what === 'new') {
    r = await call('session/new', { cwd, mcpServers: mcp, ...(process.env.SPIKE_SYSTEM ? { _meta: { antigravity: { systemPrompt: { append: process.env.SPIKE_SYSTEM } } } } : {}) });
    session = r.result?.sessionId;
    if (arg) r = await call('session/set_mode', { sessionId: session, modeId: arg });
  } else if (what === 'load') {
    session = arg;
    r = await call('session/load', { sessionId: arg, cwd, mcpServers: mcp });
  } else if (what === 'resume') {
    session = arg;
    r = await call('session/resume', { sessionId: arg, cwd, mcpServers: mcp });
  } else if (what === 'prompt') r = await call('session/prompt', { sessionId: session, prompt: [{ type: 'text', text: arg }] });
  else if (what === 'mode') r = await call('session/set_mode', { sessionId: session, modeId: arg });
  else if (what === 'model') r = await call('session/set_config_option', { sessionId: session, configId: 'model', value: arg });
  else if (what === 'close') r = await call('session/close', { sessionId: session });
  console.log(`\n== ${step.slice(0, 60)} (${Date.now() - t0} ms): ${JSON.stringify(r).slice(0, 3000)}`);
}
console.log(`\nsession ${session}`);
p.kill();
process.exit(0);

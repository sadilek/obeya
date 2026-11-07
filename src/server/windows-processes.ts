// The processes on this Windows machine with their programs, command lines and working directories
// (`folder-processes.ts`), read in a thread of their own: Windows tells no other process's working
// directory by any command (not WMI, not tasklist), and a dev server's often names its folder
// nowhere else (`node index.mjs` started there). Each is read from the process's own memory, which
// on a machine short of memory may first have to come back from disk: a fraction of a second per
// process, seconds for all, which would hold up the server's thread.

import { dlopen, FFIType, ptr } from 'bun:ffi';
import type { Running } from './folder-processes';

declare const self: Worker;

type Kernel = ReturnType<typeof loadKernel>;
let kernel: Kernel | undefined;

function loadKernel() {
  const k = dlopen('kernel32.dll', {
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
    Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    ReadProcessMemory: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  });
  const nt = dlopen('ntdll.dll', {
    NtQueryInformationProcess: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  return { ...k.symbols, ...nt.symbols };
}

/** A FILETIME (100 ns since 1601) in ms since the epoch. */
const fileTimeMs = (t: bigint) => Number(t / 10_000n) - 11_644_473_600_000;

const INVALID_HANDLE = 0xffffffffffffffffn;
/** PROCESS_QUERY_LIMITED_INFORMATION */
const QUERY_LIMITED = 0x1000;
/** PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ */
const QUERY_AND_READ = QUERY_LIMITED | 0x0010;
/** PROCESSENTRY32W on 64-bit Windows: its size, and where the process ID, its parent's and the program's name lie. */
const ENTRY = { size: 568, pid: 8, ppid: 32, name: 44 };
/** Where the 64-bit PEB points to its RTL_USER_PROCESS_PARAMETERS, and where those hold the working directory, the program and the command line. */
const PEB_PARAMS = 0x20;
const PARAMS = { cwd: 0x38, exe: 0x60, cmd: 0x70 };

/**
 * The processes on this machine, each with its program, command line and working directory read
 * from its process parameters: those started since `since` (ms since the epoch) first, then the
 * older ones (which can have moved into the folder only later) while `until` has not passed; those
 * left over without: only what the process tells without reading its memory.
 */
export function windowsProcesses(since = 0, until = Infinity): Running[] {
  kernel ??= loadKernel();
  const k = kernel;
  const snap = k.CreateToolhelp32Snapshot(2, 0) as bigint;
  if (snap === INVALID_HANDLE || snap === 0n) return [];
  const all: Running[] = [];
  try {
    const entry = Buffer.alloc(ENTRY.size);
    entry.writeUInt32LE(ENTRY.size, 0);
    for (let more = k.Process32FirstW(snap, ptr(entry)); more; more = k.Process32NextW(snap, ptr(entry))) {
      const pid = entry.readUInt32LE(ENTRY.pid);
      const ppid = entry.readUInt32LE(ENTRY.ppid);
      if (pid === 0) continue;
      all.push({ pid, ppid, exe: '', cmd: '', cwd: '' });
    }
  } finally {
    k.CloseHandle(snap);
  }
  const older: Running[] = [];
  for (const p of all) {
    if (since && startedMs(k, p.pid) < since) older.push(p);
    else Object.assign(p, readParams(k, p.pid));
  }
  for (const p of older) {
    if (Date.now() > until) break;
    Object.assign(p, readParams(k, p.pid));
  }
  return all;
}

/** When the process `pid` started (ms since the epoch); Infinity where Windows does not tell. */
function startedMs(k: Kernel, pid: number): number {
  const h = k.OpenProcess(QUERY_LIMITED, 0, pid) as bigint;
  if (!h) return Infinity;
  try {
    const times = Buffer.alloc(32);
    return k.GetProcessTimes(h, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24)) ? fileTimeMs(times.readBigUInt64LE(0)) : Infinity;
  } finally {
    k.CloseHandle(h);
  }
}

function readParams(k: Kernel, pid: number): { exe: string; cmd: string; cwd: string } {
  const none = { exe: '', cmd: '', cwd: '' };
  const h = k.OpenProcess(QUERY_AND_READ, 0, pid) as bigint;
  if (!h) return none;
  try {
    const read = (at: bigint, size: number): Buffer | null => {
      if (!at || size <= 0) return null;
      const b = Buffer.alloc(size);
      return k.ReadProcessMemory(h, at, ptr(b), BigInt(size), null) ? b : null;
    };
    const basic = Buffer.alloc(48);
    if (k.NtQueryInformationProcess(h, 0, ptr(basic), 48, null) !== 0) return none;
    const params = read(basic.readBigUInt64LE(8) + BigInt(PEB_PARAMS), 8)?.readBigUInt64LE(0);
    if (!params) return none;
    const text = (off: number) => {
      const u = read(params + BigInt(off), 16);
      if (!u) return '';
      return read(u.readBigUInt64LE(8), u.readUInt16LE(0))?.toString('utf16le') ?? '';
    };
    return { exe: text(PARAMS.exe), cmd: text(PARAMS.cmd), cwd: text(PARAMS.cwd) };
  } catch {
    return none;
  } finally {
    k.CloseHandle(h);
  }
}

if (!Bun.isMainThread) self.onmessage = (e: MessageEvent<{ since: number; until: number }>) => self.postMessage(windowsProcesses(e.data.since, e.data.until));

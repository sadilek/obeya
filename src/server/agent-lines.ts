// Lines every kind of agent shares (a card's worker, an idea's agent, a look-up's): a built-in
// tool call as the card's log shows it, a call that needs the owner's permission as their question
// shows it, and what is said of the owner's words that came through speech recognition.

import type { Messages } from '../core/messages';
import { clip } from '../core/text';

/** Said of the owner's words when they came through speech recognition. */
export const SPOKEN = 'spoken, so speech recognition may have misheard words';

/** One log line for a built-in tool call. */
export function describeTool(name: string, input: Record<string, unknown>, t: Messages): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const file = (k: string) => s(k).split('/').slice(-2).join('/');
  switch (name) {
    case 'Read':
      return t.tool.read(file('file_path'));
    case 'Edit':
    case 'MultiEdit':
      return t.tool.edit(file('file_path'));
    case 'Write':
      return t.tool.write(file('file_path'));
    case 'Bash':
      return `$ ${clip(s('command').split('\n')[0]!, 120)}`;
    case 'Grep':
      return t.tool.grep(clip(s('pattern'), 60));
    case 'Glob':
      return t.tool.glob(clip(s('pattern'), 60));
    case 'WebSearch':
      return s('query') ? t.tool.webSearch(clip(s('query'), 120)) : name;
    case 'WebFetch':
      return s('url') ? t.tool.webFetch(clip(s('url'), 120)) : name;
    case 'TodoWrite':
      return t.tool.todo;
    case 'Task':
    case 'Agent':
      return `Subagent: ${clip(s('description'), 80)}`;
    default:
      return name;
  }
}

/** What a tool call that needs the owner's permission does, as the question shows it: a command whole, line by line as code, else its log line or its input. */
export function permissionWhat(name: string, input: Record<string, unknown>, t: Messages): string {
  if (name === 'Bash' && typeof input.command === 'string') return code(clip(input.command, 4000));
  const line = describeTool(name, input, t);
  return line === name ? `${name}: ${code(clip(JSON.stringify(input), 2000))}` : line;
}

/** Each line as inline code (a line that holds a backtick as it is): the card renders no code blocks. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => (l.includes('`') ? l : `\`${l}\``))
    .join('\n');

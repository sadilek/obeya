import { describe, expect, test } from 'bun:test';
import { pastWorktreeRace } from './git';

describe('pastWorktreeRace', () => {
  const race = 'git worktree add --quiet -b obeya/b /ws/b main in /repo: fatal: failed to read .git/worktrees/a1b2c3d4/commondir: Undefined error: 0';

  test('a step that read another worktree half added runs again', async () => {
    let attempts = 0;
    const r = await pastWorktreeRace(async () => {
      if (++attempts < 3) throw new Error(race);
      return 'added';
    });
    expect(r).toBe('added');
    expect(attempts).toBe(3);
  });

  test('any other failure, or the race again and again, is the caller’s', async () => {
    let attempts = 0;
    await expect(pastWorktreeRace(async () => (attempts++, Promise.reject(new Error('fatal: invalid reference: main'))))).rejects.toThrow('invalid reference');
    expect(attempts).toBe(1);
    attempts = 0;
    await expect(pastWorktreeRace(async () => (attempts++, Promise.reject(new Error(race))))).rejects.toThrow('commondir');
    expect(attempts).toBe(5);
  });
});

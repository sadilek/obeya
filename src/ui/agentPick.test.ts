import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AGENT_DEFAULTS, type AgentsView, type Item } from '../core/types';
import { agentLabel, RunsOn } from './agentPick';
import { setLanguage } from './strings';

const view: AgentsView = {
  file: '/settings.json',
  preset: 'claude',
  agents: { ...AGENT_DEFAULTS, worker: { harness: 'codex', model: 'default', effort: 'high' } },
  harnesses: [{ id: 'codex', ready: true, models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', isDefault: true }] }],
};

afterEach(() => setLanguage('de', []));

test('inherited Codex settings are named without guessing a model, in either language and without a catalog', () => {
  for (const [language, label] of [['en', 'Use Codex settings'], ['de', 'Codex-Einstellungen verwenden']] as const) {
    setLanguage(language, []);
    expect(agentLabel(view, 'codex', 'default')).toBe(label);
    expect(agentLabel(null, 'codex', 'default')).toBe(label);
    expect(agentLabel({ ...view, harnesses: [] }, 'codex', 'default')).toBe(label);
    expect(agentLabel(view, 'codex', 'gpt-5.6-sol')).toBe('Codex · GPT-5.6-Sol');
    expect(agentLabel(view, 'codex', 'gpt-6.1-sol')).toBe('Codex · gpt-6.1-sol');
  }
});

test('an existing session still displays its actual model rather than an inherited or catalog default', () => {
  setLanguage('en', []);
  const item: Item = { id: 'c', number: 1, kind: 'task', title: 'Fix', body: '', source: 'manual', repo: 'r', state: 'working', x: 0, y: 0, runsOn: { harness: 'claude', model: 'claude-opus-5-5', effort: 'high' } };
  expect(renderToStaticMarkup(createElement(RunsOn, { item }))).toContain('Claude Code · Opus 5.5');
  expect(agentLabel(view, 'claude', 'opus')).toBe('Claude Code · Opus');
});

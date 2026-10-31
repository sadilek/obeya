import { expect, test } from 'bun:test';
import { loginError } from './auth';

test('recognizes login errors retained in older conversations and current sessions', () => {
  for (const text of [
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'Not logged in · Please run /login',
    'OAuth token expired. Please log in again.',
    'Invalid authentication token. Please run /login',
  ]) expect(loginError(text)).toBe(true);
});

test('ordinary failures do not offer a login', () => {
  for (const text of ['Build failed', 'HTTP 403 Forbidden', 'Rate limit reached', 'Invalid API key', 'Connection refused', 'gh is not logged in', 'Invalid access token', 'wrangler login failed']) {
    expect(loginError(text)).toBe(false);
  }
});

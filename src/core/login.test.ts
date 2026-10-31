import { expect, test } from 'bun:test';
import { claudeLoginFailed } from './login';

test('recognises Claude Code’s login failures in the words it uses', () => {
  for (const text of [
    'Not logged in · Please run /login',
    'Invalid API key · Please run /login',
    'API Error: 401 Invalid API key · Please run /login',
    'OAuth token revoked · Please run /login',
    'Login expired · Please run /login',
    'Invalid authentication token. Please run /login',
    'Your session has expired. Please run /login to sign in again.',
    'Not logged in. Run claude auth login to authenticate.',
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
    'Claude Code process exited with code 1. stderr: not logged in',
    'Claude Code process exited with code 1. stderr: Error: something\nNot logged in',
    // a failure Obeya words around the session's message
    'Arranging failed: Not logged in · Please run /login',
  ])
    expect(claudeLoginFailed(text)).toBe(true);
});

test('other failures, and other tools’ login errors, offer no Claude login', () => {
  for (const text of [
    'Build failed',
    'HTTP 403 Forbidden',
    'Rate limit reached',
    'Invalid API key · Fix external API key',
    'Connection refused',
    'gh is not logged in',
    'You are not logged into any GitHub hosts. To log in, run: gh auth login',
    'OAuth token expired',
    'gh: HTTP 401: OAuth token expired. Please log in again.',
    'Invalid access token',
    'wrangler login failed',
    'npm error: failed to authenticate with registry',
    'not logged in, run `azd login` to login',
    'Claude Code process exited with code 1',
  ])
    expect(claudeLoginFailed(text)).toBe(false);
});

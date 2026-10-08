// Tipjar's adapter: approved work lands on main; every change is shown in a demo.
export default {
  name: 'tipjar',
  canvasId: () => 'tipjar',
  canvasName: () => 'Tipjar',
  checks: ['bun test'],
  land: 'main',
  workspaces: 'worktrees',
  demo: {
    required: true,
    howToRun: 'The app is static: serve your worktree with `python3 -m http.server <a free port> -d <worktree>` and open `/index.html`. Keep the demo under a minute.',
  },
};

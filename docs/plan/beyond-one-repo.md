# M7 Beyond one repo

> Plan doc for milestone M7 of [`docs/plan.md`](../plan.md). Deleted when M7 ships; durable
> content moves into `docs/plan.md`.

## Goal

One Obeya for all of the owner's work: several canvases in one server, and a canvas that spans
several repositories (a product with its separate frontend, firmware or infrastructure repo).

## Design

- **Configuration.** `obeya <repo>…` still starts one canvas; several paths put several
  repositories on it (`--name` names the canvas). `obeya --config <file>` starts several canvases
  from a JSON list: `[{ "name": "Acme", "repos": [{ "path": "~/dev/app5", "adapter"?, "workspaces"?,
  "clones"? }, …] }, …]`.
- **Repositories on a canvas.** Each has its adapter, workspaces, workers, project agents and PR
  watcher. The first repository of a canvas is its home: its plan-doc references and workspace
  directory stay as they were, so existing canvases keep their data. Plan docs of the others are
  referenced as `<repo>:<path>`; the owner's cards carry their repository, chosen when the card
  is made (the home repository by default).
- **Koordinator.** One per canvas, as before; collisions only count within one repository. Voice
  commands name the repository of a new card when the canvas has several.
- **Server and UI.** The API is per canvas (`/api/c/<canvas>/…`, one WebSocket each);
  `/api/canvases` lists them. The UI opens the canvas in the address (`?c=<canvas>`), else the
  first, and the top-left pill switches between canvases. On a canvas with several repositories,
  cards name their repository.

## Workstreams

- [ ] **W1:** Repositories on a canvas: cards and plan docs per repository, routing to its workers.
- [ ] **W2:** Several canvases in one server; per-canvas API and WebSocket; configuration file.
- [ ] **W3:** UI: canvas switcher, repository on cards and when making one.
- [ ] **W4:** Live: Obeya and a scratch repository on one canvas, Acme on a second.

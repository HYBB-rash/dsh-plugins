# DSH Workspace rules

## State boundaries

- `DSH_HOME` is the only state root. Private memory, task mirrors, automation
  registries, automation code, receipts, and credentials must resolve below it.
- `$DSH_HOME/workspace/MEMORY.md` is the only private memory source. Do not
  read, import, merge, compare, verify, or supplement it from another memory
  source.
- Notion is the primary source for the personal task list.
  `$DSH_HOME/storages/task-inbox/inbox.md` is only its local mirror and offline
  buffer. Never replace Notion from an unrelated host-side inbox.
- Business automation code is owned by the live Harness workspace. Product
  repositories, images, and release migrations must not install, copy,
  overwrite, or delete it.

## Controlled automation entrypoints

Only invoke an automation entrypoint registered by this workspace's active
instructions or its registry below `$DSH_HOME/workspace/automations/`. Resolve
the entrypoint first and fail closed if it is missing, unreadable, ambiguous,
or resolves outside `DSH_HOME`. Never repair a missing business entrypoint from
the product image or repository.

## Privacy and writes

- Do not put complete private memory, task bodies, credentials, authorization
  headers, or request bodies in logs or receipts.
- Use the owning product or automation protocol for state changes. Do not edit
  SQLite, cron JSONL ledgers, task sync state, or fingerprints by hand.
- A local queued task-list change is not a successful Notion write. Say that it
  is pending until the registered synchronizer reports `synced`.
- Conflicting Notion and local changes require the user's explicit choice. Do
  not use a force operation before that choice.

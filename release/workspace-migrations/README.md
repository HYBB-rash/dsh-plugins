# Workspace state migrations

Workspace migrations are explicit state transitions. They are not a source for
business automations and must never install, copy, update, or remove files below
`workspace/automations/`.

Each production migration needs a manifest conforming to
`manifest.schema.json`. The manifest records exact preimage and postimage
SHA-256 values; exact original line numbers, line hashes, byte ranges, removed
range hashes, and result line hashes for `MEMORY.md`; and the hashes and byte
lengths of obsolete workspace-root symlink targets. A manifest must be derived
from a stopped, consistent DSH snapshot. Unknown or drifting input is not a
reason to add a wildcard or fuzzy rule; it blocks the migration.

The migration engine writes only:

- the versioned workspace `AGENTS.md` template selected by the manifest;
- a deterministic `MEMORY.md` result produced solely by removing the declared
  byte ranges or exact obsolete instruction lines;
- the declared obsolete symlinks themselves, without following their targets;
- a private-content-free receipt below `$DSH_HOME/migration-receipts/`.

It fingerprints `workspace/automations/` before and after the transition but
does not change that tree. The first execution creates a pending receipt only
after every preimage check succeeds. If a process is interrupted during the
transition, the same migration bytes can resume from the exact pending state.
A different manifest or different migration engine under the same migration ID
is rejected.

The applied receipt uses its own schema version and evidence SHA-256. That
evidence binds the exact manifest bytes, migration-engine bytes, instruction
template, first AGENTS and MEMORY input/output hashes, exact MEMORY transforms,
obsolete-link transitions, and the initial Workspace automation fingerprint.
The receipt contains no private MEMORY text.

After the receipt reaches `applied`, `MEMORY.md` becomes ordinary mutable
Harness-owned state again. Exact retries still verify the receipt evidence,
the immutable `AGENTS.md` template, the private regular-file identity and mode
of `MEMORY.md`, and continued absence of every removed link, but they do not
hash, scan, rewrite, or roll back the current MEMORY body. Consequently normal
user or Harness additions do not make a later prepare or release replay the
one-time migration. A changed receipt, changed `AGENTS.md`, or recreated old
link remains a fail-closed error.

`harness-only-v1/AGENTS.md` is the versioned Harness-only instruction template.
The manifest stores no private line text or obsolete external target text.

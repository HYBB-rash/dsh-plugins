You are creating the first production Notion inbox automation in two bounded,
sequential authoring phases.  This is the shared contract for both phases.  A
trusted phase directive appended after this contract names the exact artifacts
that the current phase may create.  Follow that directive literally; requirements
for the other phase are interface context, not permission to create its files.

The working directory is empty apart from artifacts explicitly preserved from the
previous phase.  You cannot see the production workspace, other automations,
credentials, Telegram, cron, Notion, or OpenClaw.  Do not try to find or contact
any of them.  Do not create a handoff file, test receipt, cache, log, fixture
directory, configuration file, or secret.  Do not put private task text or a real
token/page identifier in any file.  The release helper will perform all external
verification after both phases exit.

`notion_inbox_sync.py` must be a Python 3 standard-library-only command-line
program.  It must expose `--pull`, `--set`, `--push`, `--force`,
`--retry-pending`, and `--json`; `--set -` reads the complete replacement body
from stdin.  It must consume only `NOTION_TOKEN_FILE`,
`NOTION_INBOX_FILE`, `NOTION_API_BASE`, and `NOTION_PAGE_ID`; and use only the
single configured Notion page.  It must never consult DSH_HOME.  The durable
artifact contract is:

The release-owned tracer admits a deliberately narrow static Python subset.
Import only `__future__`, `argparse`, `contextlib`, `dataclasses`, `datetime`,
`errno`, `fcntl`, `hashlib`, `http`, `io`, `json`, `os`, `pathlib`, `re`,
`secrets`, `shutil`, `stat`, `sys`, `tempfile`, `time`, `typing`, `urllib`,
or `uuid`.  Do not access underscore-prefixed or dunder attributes, dynamically
import or compile code, create subprocesses, monkeypatch modules, inspect
frames or trace state, or use any of these builtins: `__import__`, `breakpoint`,
`callable`, `chr`, `compile`, `delattr`, `dir`, `eval`, `exec`, `getattr`,
`globals`, `hasattr`, `id`, `locals`, `ord`, `repr`, `setattr`, `type`, or
`vars`.  Direct comparisons, `isinstance`, dataclasses, and ordinary public
methods are available instead.  Call traced `fcntl`, `io`, `os`, `sys`, and
`open` operations directly at their call site; do not alias, store, pass,
return, yield, or use those modules/functions as defaults or container members.
`io.FileIO` is unavailable everywhere, including for non-token artifacts.

- mirror: the exact absolute `NOTION_INBOX_FILE`, normally
  `storages/task-inbox/inbox.md` below DSH_HOME;
- state: `Path(NOTION_INBOX_FILE).parent / "sync-state.json"`, mode 0600;
- fingerprint: `Path(NOTION_INBOX_FILE).parent / "notion-fingerprint.json"`,
  mode 0600.

The public 2026-03-11 API contract is fixed: GET and PATCH exactly
`${NOTION_API_BASE}/pages/{NOTION_PAGE_ID}/markdown`, with `Authorization:
Bearer <token>` and `Notion-Version: 2026-03-11`.  A full replacement PATCH body
is exactly `{"type":"replace_content","replace_content":{"new_str":<full
body>}}`.  A successful GET or PATCH response is accepted only when it contains
`markdown` as a string, `truncated` as false, and `unknown_block_ids` as an empty
list.  Do not follow redirects or use any other method/path.  The transport must
match the configured scheme: `https://` uses a TLS HTTPS connection (including
the default port 443), while `http://` is reserved for the isolated fake service
and uses a plain HTTP connection.  Tests must exercise both constructor choices;
a fake HTTP-only server cannot prove production HTTPS support.

Every individual artifact replacement must use create-only temporary files
whose mode is 0600 from the instant they are created, fsync, close every
writable file descriptor or handle before publication, and atomic rename.
Changing a temporary file to 0600 only after creation is not sufficient.
Permission, ownership, ACL, and metadata-copy mutators are unavailable: do not
use `chmod`, `fchmod`, `lchmod`, `chown`, `fchown`, `lchown`, `setxattr`,
`removexattr`, `copymode`, or `copystat` on any path or descriptor.
Cross-file logical consistency must use an explicit pending journal and
deterministic recovery; do not claim that three different paths can be renamed
in one filesystem transaction.  A pull is GET-only.  A
normal push must detect a remote/local conflict without overwriting it.  `--force`
is the only conflict override.  A failed write must leave a retryable pending
operation; `--retry-pending` must replay exactly that operation.  A pull failure
must not create pending work.  When there is no pending work, retry must perform
no API request.  JSON stdout must be bounded, machine-readable, and free of
tokens, Authorization headers, response bodies, and private inbox text.  Every
non-silent JSON result must be exactly `json.dumps` of its status object with
default separators, followed by a single trailing newline: for example
`{"status": "synced"}\n`.  Tests must construct the expected bytes with
`json.dumps` (or a semantically equivalent fixed literal) and must not expect
any other whitespace.  Diagnostics must be fixed and similarly redacted.  Never refer to `.openclaw`,
old task-inbox workflow paths, Telegram, cron, or a real Notion endpoint/page/token.

At the start of every invocation that performs an operation, use non-following
metadata checks to reject a symbolic-link preimage at `NOTION_TOKEN_FILE` or at
any of the three canonical artifact paths.  Complete all four preflight checks
before opening or reading the token, making any API request, creating a directory
or temporary file, or making any other persistent write.  The no-op
`--retry-pending --json` path is the sole exception: when the persisted journal
holds no pending operation, resolve nothing token-related at all (no stat,
readlink, open, or read of `NOTION_TOKEN_FILE`) and call no API; decide from the
journal alone before any token or preflight handling, and exit zero with empty
stdout and stderr.  If any preimage is a symlink, exit nonzero without
opening or reading its target and without GET, PATCH, or other HTTP traffic.  The
task directory and every other writable path available to the invocation must
remain exactly as they were before the call; do not even create and remove an
empty task directory.  Do not create, remove, rename, rewrite, chmod, or replace
anything.  Preserve every directory entry, the symlink's exact target and full
stable identity, and the target canary's bytes and full stable identity.  Neither
stdout nor stderr may contain any byte sequence read from a symlink target.

The first successful pull must create all three canonical artifacts.  After
initialization, rewrite only the canonical artifacts whose content or durable
state actually changes; a role whose content and durable state are unchanged
must not be rewritten at all — its inode must remain identical, including in a
crash-recovery invocation, which must never republish an unchanged role.  Persist any
retryable pending operation inside the three canonical artifacts, not as a
fourth durable file.  One invocation may perform at most one GET, at most one
PATCH, and at most 32 total rename calls, including canonical, staged, and
journal paths.  A normally returning invocation must not catch and continue
after a failed rename call: every attempted rename must complete.  A crash may
occur before the token is opened, or after a
complete safe token read but before any API request; that is valid when the next
invocation deterministically recovers from the already-published journal state.
Never place a rename between opening and closing the token descriptor.

For every successful operation that changes mirror, state, or fingerprint,
create each distinct temporary file directly inside the task directory with
`os.open` using `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC` and mode 0600,
write it sequentially with `os.write`, fsync it after the final write, close its
descriptor, rename it over that one canonical artifact so its inode changes,
and fsync the containing task directory after the final canonical rename.  Do
not use high-level writable file handles, hard links, or symbolic links for
canonical, staged, journal, or temporary files.  Every such file must be owned by
the current process uid and gid
and have exactly one link.  If the process exits immediately before or after any individual
rename, the next invocation must deterministically finish or recover the journal,
remove every staged temporary or extra journal artifact left by either boundary,
and converge.  Crash residues must be direct-child regular files in the task
directory, owned by the current process uid and gid, mode 0600 with one link.  Never publish a staged file left by a prior
process: remove it, create and fsync a replacement at a fresh direct-child
pathname, then publish that new file.  Keep every staged or journal path directly
inside the task directory.  Fsync the task directory after removing crash residue.  The
task directory after any completed invocation must contain exactly the three
canonical artifacts and nothing else: inspect every direct-child entry first,
and any direct-child regular file that is not one of the three canonical
artifacts (a staged, journal, or residue file) must be validated as owned by
the current process uid and gid, mode 0600, one link, removed, and the task
directory fsynced before any further work.  The same invariant holds after a
crash-recovery: if any boundary is interrupted, the next invocation must return
the task directory to exactly those three files even when the recovery finds
nothing more to upload.  A second
equivalent pull must leave all three canonical artifact bytes unchanged.  A
crash-recovery invocation must converge the journal as well: immediately
afterwards the same `--retry-pending --json` with no pending operation must be
the silent success described above, with no token touch and no API request.
Every crash-recovery invocation must end by opening the task directory itself
and `os.fsync`ing that directory descriptor as its final durability step, after
removing every residue and after the final canonical rename; fsyncing a file
descriptor or any other directory does not satisfy this.

Read the token only from `NOTION_TOKEN_FILE`, using a read-only descriptor opened
with both `O_NOFOLLOW` and `O_CLOEXEC`, and check that its identity is stable
before and after the complete read.  Read its bytes sequentially and directly
with `os.read` from offset zero through the exact `fstat` size.  Do not seek,
duplicate, transfer, wrap, or reopen that descriptor with `fdopen`, `open(fd)`,
`io.open`, or `io.FileIO`.  Never put the token in argv, durable state, JSON, or
diagnostics.  `--retry-pending --json` with no pending operation is the sole
silent success: exit zero with empty stdout and stderr, and make no API request;
it must not even perform a metadata check (stat or readlink) on
`NOTION_TOKEN_FILE`, much less open or read it.

Every non-silent JSON result has one fixed `status`, chosen only from `synced`,
`queued`, `stale`, `conflict`, or `error`.  A GET failure with an existing mirror
is `stale` and makes zero persistent changes; without a mirror it is `error`.
A set or push whose remote write fails after the local replacement is safely
saved is `queued`.  If the candidate local body and current remote body both
differ from their common base and from each other, a normal operation is
`conflict`.  A successful or already-equivalent operation is `synced`.  `--force`
changes conflict ownership only: `--pull --force` makes the Notion body win;
`--push --force`, including set-and-push, makes this invocation's body win.

The common base is the exact Notion body last confirmed by a successful sync to
be shared by the local mirror and the remote page.  This is a public behavioral
concept, not a required `state` or `fingerprint` JSON schema.  Apply these exact
state transitions consistently in both the implementation and its tests:

- with no canonical artifacts, the first successful pull establishes the common
  base, creates all three canonical artifacts, and returns `synced`;
- after that sync, a pull with only the remote body changed adopts the remote body
  and returns `synced`;
- after that sync, a push with only the local mirror changed PATCHes the local
  body and returns `synced`;
- after that sync, a set while the remote body still equals the common base
  PATCHes the complete input body and returns `synced`;
- an operation is `conflict` only when its candidate local body and the current
  remote body both differ from the common base and also differ from each other;
  normal pull, push, and set must then leave both sides unchanged and make no
  PATCH;
- whenever the candidate local body and current remote body are already equal,
  the operation returns `synced` even if both differ from the older common base.

Every request must obey the exact wire contract (the release-owned contract
probe enforces these counts; per operation since the previous API call, never
more and never fewer): a `--pull` that returns `synced` or `stale` performs
exactly one GET and zero PATCHes; `--pull --force` also performs exactly one GET
and zero PATCHes; `conflict` detection for `--pull`, `--push`, or `--set`
performs exactly one GET (to fetch the current remote body) and zero PATCHes;
a successful `--push` or `--set` performs at most one GET (its conflict
detection fetch) and exactly one PATCH carrying the complete candidate body; a
`queued` result performs exactly one attempted PATCH, and the later
`--retry-pending` replays exactly one PATCH with the same body; the no-op
`--retry-pending --json` performs zero requests.  Never PATCH on a `--pull`.

`tests/test_notion_inbox_sync.py` must use only the Python standard library and a
loopback fake HTTP Notion server.  It must use a visibly fake token and synthetic
task text.  Define exactly one public unittest class named
`NotionInboxSyncContractTests` with these exact twelve test methods:

- `test_atomic_artifacts`
- `test_conflict`
- `test_first_pull`
- `test_force`
- `test_network_recovery`
- `test_no_pending_no_api`
- `test_pending_retry`
- `test_pull_failure_no_pending`
- `test_push`
- `test_read`
- `test_secret_redaction`
- `test_set`

Each method must make real assertions against `notion_inbox_sync.py`; do not use
placeholder passes, skipped tests, expected failures, dynamically fabricated test
methods, or an all-true receipt.  The fake server must record method/path/request
counts needed by those assertions and must reject unexpected APIs.  Tests must
not access external networking and must keep every temporary artifact outside the
working directory.

Every test that needs an initialized state must establish its common base by
running a successful first pull through the public CLI against the fake server;
a test that explicitly verifies a failed first pull may start without a common
base.  Use this exact production-equivalent boundary for every first-pull test:
the visibly fake token file contains printable non-whitespace ASCII token bytes
with no line terminator; `Path(NOTION_INBOX_FILE).parent.parent` already exists,
while
`Path(NOTION_INBOX_FILE).parent` and all three canonical artifacts are absent;
and `NOTION_API_BASE` ends exactly in `/v1` with no trailing slash.  The fake
server must require the final request path to be exactly
`/v1/pages/{NOTION_PAGE_ID}/markdown`, proving that URL construction preserves
the configured base path.  `test_no_pending_no_api` must prove the no-op
boundary at the filesystem level: after the common base is established, relocate
`NOTION_TOKEN_FILE` to a path whose parent directory has no search permission
(or otherwise make every pathname resolution of it fail), run
`--retry-pending --json`, and require exit zero with empty stdout and stderr,
zero fake-server requests, and all three artifact bytes unchanged.  A FIFO or an
unreadable file alone is insufficient: a metadata-only check still succeeds on
both, while the contract forbids even that.  Treat the contents of
`sync-state.json` and `notion-fingerprint.json` as private implementation details:
tests may verify that they are safe JSON files, but must not fabricate, rewrite,
or depend on any private field or schema.  Use the mirror as the only directly
editable local body and the fake server as the only directly editable remote
body.  In `test_atomic_artifacts`, start with all three canonical artifacts
absent, run the first pull and require `synced`, save the bytes of all three
artifacts, leave both the mirror and fake remote body unchanged, then immediately
run an equivalent second pull and require `synced` with all three artifact bytes
unchanged, then run the same silent no-op proof with the un-resolvable
`NOTION_TOKEN_FILE` and require the task directory to contain exactly the three
canonical artifacts with no extra residue.  The fake server's counters start
from zero for every test method (each method owns its own fresh server) and
that lifetime total must be asserted by exact number, never computed as a
delta: `test_first_pull` finishes at exactly 1 GET and 0 PATCHes;
`test_atomic_artifacts` finishes at exactly 2 GETs (first pull plus equivalent
second pull, then the no-op proof adds none) and 0 PATCHes; `test_conflict`
finishes at exactly 2 GETs (the baseline first pull plus the conflict
`--push`'s one detection GET) and 0 PATCHes, and must follow exactly: establish
the common base with a first pull, rewrite only the local mirror and the fake
remote body to two different edits, run `--push --json` and require exit zero
with status `conflict`, with the remote body still equal to the remote edit and
the mirror still equal to the local edit.  The total of 2 GETs includes the
baseline pull: a conflict operation adds exactly one GET, it never replaces the
baseline.  The harness reruns every test method in its own fresh process and
container, so every method must be self-contained, must establish its own
baseline, and must pass independently of any other method.  Do not turn
`test_atomic_artifacts` into a conflict scenario; exercise
the two-sided divergence rule in `test_conflict`.

The appended phase directive is the sole authority for the current phase's output
paths and final response.  Never create or modify an artifact assigned to the
other phase.

# Coordination in Sessions

Session coordination stores external events as reserved records in the session file. This page describes those records and how sessions, the session tree, forks, and compaction treat them. For the APIs that write and read them, see [SDK Coordination](coordination-sdk.md) and [Extension Coordination](coordination-extensions.md).

## Durable external records (opt-in)

Session format version remains 3. `SessionManager.persistNow()` explicitly saves even an empty conversation, opts the header into `durableRecords: 1`, and enables synced subsequent appends. It does not add a user prompt. Ordinary unopened/unused sessions retain deferred persistence. Unknown durable-record versions are refused without rewriting.

`pi.external-record.v1` is reserved `custom` metadata with versioned canonical or admission data. Canonical identity is `(recipientIdentity, eventId)`; admission identity adds `requestId`. `pi.external-history.v1` is inert inherited admission history with a self-contained original session, entry, request, instance, epoch, branch anchor, envelope, and provenance, plus the immediate `copiedFrom` session and entry. These records are not editable prompts or permission to dispatch a model request.

Only admissions and inherited history on the selected, retained ancestry project into model context: `buildSessionContext()` turns each into its immutable envelope, while ordinary `custom` entries still produce no context message. Canonical records, whole-file delivery state, and display cards do not. Compaction can summarize admitted history away. The conversation-wide pending shelf is a display projection, not model input. The selected ancestry also determines ordinary compaction and branch-summary inputs; unread canonical envelopes are excluded.

`pi.active-selection.v1` is a reserved physical selection journal. It is excluded from public tree entries and model context. Ordinary appends advance selection; navigation durably records selection; external-record appends preserve it. Reopening never selects an external record merely because it was physically appended last.

Strict durable files repair an incomplete final JSON suffix before another write. A complete unterminated JSON object is retained and newline-terminated. An incomplete suffix is truncated to the last complete line. Versions, record objects, reserved schemas, selection targets, and duplicate IDs/keys are validated before repair. Malformed completed lines and unknown reserved schemas are errors, not permission to create another receipt. Read-only discovery accepts a recoverable prefix without changing disk so `--continue` can reopen and repair it. Legacy files keep their existing permissive load/migration behavior. Explicit adoption refuses bytes requiring lossy repair and remembers a failed preflight from that manager's original open even if legacy loading normalized the file.

Ordered admission uses the existing v3 canonical and admission encoding; it adds no new schema marker. The authority returns immutable entry IDs, timestamps, records, and chained parent anchors. Pi materializes the validated chain without moving selection; the first owned assistant start adopts its tip. Explicit reconciliation repairs missing entries at recorded anchors without selecting a branch or replaying a request. Recovery preserves the recorded envelope, including any workspace note, rather than resampling or rerendering it. A durable admission or local read does not prove provider receipt; dispatch after invocation can remain uncertain.

Older Pi builds may read the inert custom metadata but lack the projection and history semantics and are not supported integrations. Integrations must check `durable-records/1`, `logical-external-events/1`, `host-runtime-lifecycle/1`, and `ordered-request-admission/1` independently, not only package versions. Never substitute `custom_message` for an admission. One writer per file is required; cross-process attachment fencing is a separate contract. Raw metadata is not sandboxed from extensions that deliberately inspect it.

Runtime handover does not change the v3 canonical or admission encoding, or append host credentials and attachment permissions to the transcript. It does not transfer durable work ownership to a different mailbox. The ended-identity case in tests seeds an already detached identity in a fake; it is not a close or transfer implementation. See [SDK runtime lifecycle coordination](coordination-sdk.md#runtime-lifecycle-coordination) for the verified boundary and limitations.

## Sessions and branches

`--continue` opens the most recently modified session containing conversation or coordination content for the current working directory. If all saved sessions are unused/header-only registrations, it falls back to the most recently modified saved session.

External event records can be selected, searched, inspected, and explicitly copied in `/tree`. They never prefill the editor, and double-Escape prompt history and fork selection do not treat them as user prompts. Inspection or copying by a person does not include the content in a model request.

Supported `/fork`, `/clone`, and CLI `--fork` copies remove pending canonical bodies and live admission records. Already-admitted history becomes inert inherited history with its original provenance; tree references and the selected branch are repaired after removal. `/fork` and `/clone` copy the chosen path; `--fork` copies the tree. These copies do not carry mailbox ownership or cached disposition state.

Pending external events can appear on a conversation-wide shelf even when delivered on another branch; their canonical bodies are not model input. Selected retained admissions are model history and can be summarized away.

An ephemeral `--no-session` run cannot participate in saved runtime coordination. Loading without participation does not itself force a session save. For the supported replacement and mailbox boundaries, see [SDK runtime lifecycle coordination](coordination-sdk.md#runtime-lifecycle-coordination).

## Compaction

Both ordinary compaction and branch summarization exclude unread canonical external-event bodies, including pending and expired events. Selected retained admission and inherited-history envelopes are ordinary summarizable history; after compaction they need not remain as cards and do not return as pending. This projection is not a sandbox: extension hooks with raw session metadata can deliberately read or forward canonical records.

For a bound ordered request, Pi reserves estimated space for whole candidate envelopes and mandatory body-free dispositions before routing and compaction. It preserves unsent input and complete continuation tool groups, then budgets final normalized messages against the routed model. The estimate is not exact provider tokenization. A candidate becomes admitted only if it survives transformation and conversion as a complete standalone message; staging or durable delivery alone is not a read. See [Ordered request admission](coordination-sdk.md#ordered-request-admission).

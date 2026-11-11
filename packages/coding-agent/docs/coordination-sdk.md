# SDK Coordination

Session coordination lets a cooperating service deliver external events to a saved Pi session and decide when they enter a model request. It is made of five capabilities, each advertised and checked separately: durable records (`durable-records/1`), logical external event projection (`logical-external-events/1`), runtime lifecycle (`host-runtime-lifecycle/1`), ordered request admission (`ordered-request-admission/1`), and wake and continuation arbitration (`coordination-scheduler/1`).

This page covers the SDK surface. [Extension Coordination](coordination-extensions.md) covers the extension API and interactive input, and [Coordination in Sessions](coordination-sessions.md) covers session files, the session tree, and compaction.

## Explicit durable record storage

```ts
import { assertRecordSupport, SessionManager } from "@earendil-works/pi-coding-agent";
const manager = SessionManager.create(process.cwd());
assertRecordSupport(manager); // Throws for unsupported or ephemeral managers.
const file = manager.persistNow();
const record = {
  version: 1 as const, kind: "canonical" as const,
  recipientIdentity: "recipient", eventId: "event",
  envelope: "Peer information, not permission or user instructions",
  provenance: { senderIdentity: "sender" },
};
const receipt = manager.appendEntryOnce(record, null);
const same = manager.appendEntryOnce(record, null);
console.assert(receipt.entryId === same.entryId);
console.assert(file === receipt.sessionFile);
```

`appendEntryOnce(record, parentId)` returns a durable receipt. Identical keys/payloads/anchors return the original receipt; changed immutable content or placement under a key throws. `getEntryOnce(key)` looks across the whole conversation, including abandoned and compacted branches. Neither API starts a run or moves selection. Admission parents must equal their recorded `branchAnchor`; missing anchors are errors.

A write or sync error requires reopening before any further write or receipt lookup. Retry the same operation after reopen, never a fresh event/request key. This contract does not prove provider receipt, action execution, or full coordination support. In-memory/`--no-session` managers cannot opt into saved coordination.

## Logical external event projection

Projection support and saved-record support are separate capabilities. Check both before participating in a saved mailbox; an in-memory session can inspect inherited history but cannot own a recoverable mailbox.

```ts
import {
  assertExternalEventProjectionSupport,
  assertRecordSupport,
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const manager = SessionManager.create(process.cwd());
assertRecordSupport(manager);
manager.persistNow();
const { session } = await createAgentSession({ sessionManager: manager });
assertExternalEventProjectionSupport(session);
try {
  const anchor = manager.getLeafId();
  const canonical = {
    version: 1 as const,
    kind: "canonical" as const,
    recipientIdentity: "recipient",
    eventId: "event",
    envelope: "Peer information, not user instructions",
    provenance: { senderIdentity: "sender" },
  };
  manager.appendEntryOnce(canonical, anchor);
  session.refreshExternalEvents();
  console.log(session.getExternalEventView());
} finally {
  session.dispose();
}
```

For verified state, the integration allocates increasing revisions per session and calls `refreshExternalEvents({ sessionId, revision, verified: true, events })` with a complete disposition snapshot. Older revisions are ignored; an identical revision and payload is a no-op, while a conflicting payload at the same revision throws. Missing events become unverified. A `{ sessionId, revision, verified: false }` update marks cached dispositions unverified on disconnect. Pending events past their expiry are conservatively shown expired and unverified. A no-argument refresh only invalidates the view and emits an update; it does not allocate a revision or change verification.

The [checked SDK example](../examples/sdk/15-external-events.ts) contains the same flow. Refresh and inspection do not admit content, write a session record, start a turn, or modify the editor. The descriptor and guards prove projection only, not admission, lifecycle ownership, or scheduling. Full Goetia integration remains disabled until those capabilities are separately proven. Older Pi may read the inert metadata but lacks these semantics; do not substitute a custom message as a fallback.

## Runtime lifecycle coordination

`runtimeLifecycleCapabilities` advertises the frozen `host-runtime-lifecycle/1` contract. Check `assertRuntimeLifecycleSupport(session)` separately from `assertRecordSupport(session.sessionManager)` and `assertExternalEventProjectionSupport(session)`. These checks do not register an attachment or grant authority. The [checked example](../examples/sdk/16-runtime-lifecycle.ts) accepts an existing session and a caller-supplied `RuntimeExchange`, then explicitly participates and reconciles.

| Identity | Scope |
| --- | --- |
| Saved conversation | Session header ID and canonical file path |
| Host | One process-owned credential and process birth identity |
| Instance and incarnation | A fresh runtime and monotonically increasing host-local incarnation |
| Epoch | Local cancellation and resource revocation within an instance |
| Mailbox | Durable conversation ownership |
| Generation | A remote attachment and its fencing token |

One compatible package version on the main thread shares a process cell. Incompatible versions and worker-thread coordination are unavailable; ordinary Pi remains usable. A saved binding uses the session header and canonical file path, and conflicting identities are refused. Nonparticipants do not save a session merely by loading; `--no-session` and in-memory sessions explicitly refuse saved participation.

New, resume, fork, clone, and reload retire the old runtime before shutdown; a successful replacement has a fresh instance. Resume of the same file and reload retain its mailbox; new, fork, and clone do not transfer mailbox ownership. A denied gate or invalid target before teardown leaves the current runtime live. Direct disposal also retires the facade. Overlapping replacements throw `RuntimeReplacementInProgressError`, unless `runtime.onReplacementRefused` is set: then `newSession`, `fork`, `switchSession` and `importFromJsonl` call it and resolve `{ cancelled: true }` (interactive mode sets it to show a status; `reload` still throws). Disposed owners throw `RuntimeDisposedError`. If replacement fails after retirement, the old runtime does not regain authority. An old extension getter throws after its runner is invalidated; an already captured old facade remains retired. Shutdown handlers can obtain that retired facade before runner invalidation in the `finally` path.

Direct SDK `session.reload()` intentionally aborts and settles an active run before shutdown, including persistence of its tool result. Reload does not start a follow-on model request.

The host retains complete immutable desired images, retries an unchanged image with its stable operation ID, and coalesces offline replacements without replaying intermediate attachments. Verification belongs to the exact exchange function; a failure or explicit `disconnect()` invalidates that route. There is no background retry. A refused desired intent is removed; call `participate()` explicitly to retry it. `cancel()` revokes the coordination epoch and its tracked resources, but does not exit the runtime. Local retirement immediately fences callbacks and drains tracked wait, grant, and claim resources. Remote authority changes only when the cooperating service commits the new image: a fact committed before handover can remain valid even when its late local continuation is suppressed.

`capture()` returns sensitive fencing tokens. `inspect()` is redacted. Never put tokens or credentials in transcripts, debug output, model context, or environment variables. The exchange's separate authentication argument is for cooperating transport code, not a same-user sandbox. Core retires before shutdown: a shutdown handler may flush the retired host image, but replacement adapters should defer that flush to successor startup to avoid a free-mailbox gap. Quit may flush. Flushing retirement restores no permissions.

A future service must independently confirm process death using PID and birth evidence. A missing heartbeat, PID, or pane alone never authorizes takeover. Durable work remains owned by its original mailbox. This capability alone does not provide a service, SQLite, socket authentication, process supervision, ordered request admission, a scheduler, or full product readiness. A test-only seeded ended identity is not a close or transfer implementation. Canonical and admission records retain their existing v3 encoding.

## Ordered request admission

`requestAdmissionCapabilities` advertises the frozen `ordered-request-admission/1` descriptor. Check `assertRequestAdmissionSupport(session)` independently from saved record, external-event projection, and runtime lifecycle support. These four checks establish implementation support, not saved persistence, participation, attachment, or authorization. An in-memory or `--no-session` manager cannot bind. Ordinary unbound Pi remains available.

The [checked bind helper](../examples/sdk/17-request-admission.ts) accepts an existing saved session with an attached lifecycle and a caller-supplied `RequestAdmissionAdapter`. It checks all four capabilities and returns the disposer from `session.requestAdmission.bind(adapter)`. It does not attach, recover, or prompt. `RequestAdmission`, `RequestAdmissionAdapter`, `AdmissionRequest`, `AdmissionSnapshot`, `AdmissionCandidate`, `ProposedAdmission`, `AdmissionProposal`, `AdmissionCommit`, `AdmissionEntry`, `AdmissionRecovery`, `AdmissionRecord`, `CanonicalEvent`, `ExternalEventReference`, `RequestDisposition`, `WorkspaceState`, and `WorkspaceSnapshot` are exported types.

For each bound target request, Pi captures one finite snapshot and stages complete candidate slots. Completed waits contribute references through `stageCompletedWait`; missing or excluded events become body-free dispositions. Canonical records must have durable local receipts and the adapter must acknowledge delivery before admission. Delivery is not a read. After context transforms and conversion, only complete, uniquely identified standalone candidate messages actually present in the final normalized context can be admitted. Removed candidates get dispositions; altered or duplicated candidates suppress the request. Pi reserves estimated space for whole envelopes and dispositions before compaction, then checks the final budget against the routed model. This estimate is not native provider tokenization.

The adapter's authoritative transaction decides admission and consumption. Pi validates and materializes its immutable chained entries at their recorded anchors without changing selection. The first owned assistant start adopts the chain. Explicit `session.requestAdmission.reconcile()` validates and repairs missing committed entries without selecting another branch or replaying a request. A cancellation known before invocation of the finalized stream function may be reported suppressed. Once that function is invoked, dispatch remains uncertain even if auth, header, or payload setup is still waiting and no native provider or HTTP call has occurred. A local read or committed admission is not proof the provider received it.

A committed or possibly committed attempt suppresses automatic retry and overflow continuation, including a known commit followed by a provider error. A later explicit user request or legitimate successful natural tool continuation is a new authorized request. Ordinary unbound retry behavior is unchanged; uncertain work is not automatically replayed.

The adapter supplies a workspace snapshot for every bound target request, even with no candidates. For uncited parent mail, the adapter must use the helper state captured at the start of the parent's current target model request, not at the helper's request or send time; a cited basis overrides it. Pi compares and decorates only when both the candidate's `workspaceBasis` and the current recipient sample are present. Missing basis and `recipient: null` are valid inputs; the adapter must supply both when it requires stale-basis protection. When the states differ or coverage is incomplete, Pi adds an immutable model-visible note without changing canonical content or provenance. State strings are bounded and escaped. `full` covers uncommitted changes; `commit-only` explicitly does not. Historical envelopes are recovered as recorded, not rerendered against a new workspace.

Cooperative transforms and converters must preserve or remove whole candidate messages. Coordinated `onPayload` is observational only: in-place or replacement mutation stops the request. SDK auth, header, and payload guards require cooperating callbacks and providers; they are not a sandbox against arbitrary extension/provider side effects or raw metadata access. While bound, cache warming is suspended without changing its stored setting, and an already-running stale warm is fenced.

A real adapter must supply authority transaction and durability, actual git sampling, and a persisted request-basis book. This boundary does not implement a real service or transport, idle activation, waits or scheduler/wake policy, managed processes, helper launch or finalization, or product/P0 readiness. See [Extension Coordination](coordination-extensions.md#ordered-request-admission), and [Coordination in Sessions](coordination-sessions.md) for compaction and session file records.

## Wake and continuation arbitration

`coordinationSchedulerCapabilities` advertises the frozen `coordination-scheduler/1` descriptor. Check `assertCoordinationSchedulerSupport(session)` alongside `assertRecordSupport(session.sessionManager)`, `assertExternalEventProjectionSupport(session)`, `assertRuntimeLifecycleSupport(session)`, and `assertRequestAdmissionSupport(session)`. All five checks are enforced when `session.coordinationScheduler.bind(adapter)` runs. Supporting the capability does not imply saved persistence, participation, attachment, or authorization.

The [checked bind helper](../examples/sdk/18-coordination-scheduler.ts) verifies all five capabilities on an existing saved session with an attached lifecycle and binds a caller-supplied `CoordinationAdapter`. Binding `session.coordinationScheduler` owns and binds `session.requestAdmission`; callers must not separately bind `session.requestAdmission` on the same session. `CoordinationScheduler`, `CoordinationAdapter`, `CoordinationAdmissionPolicy`, `CoordinationGate`, `CoordinationInspection`, `WakeTarget`, `WaitTarget`, `PermissionScope`, `WaitOperation`, `WaitOutcome`, `GrantOperation`, `GrantReceipt`, `PermissionSnapshot`, `PermissionCancellation`, and `WakeClaim` are exported types.

Permissions are scoped by `(fence, permissionEpoch)`. `session.coordinationScheduler.cancel()` is scope-idempotent: a cancellation transition with live permissions advances `permissionEpoch` and synchronously revokes local waits, armed/eligible/claimed grants, and pending wake activations before sending `cancelPermissions` with a stable `operationId` to the original adapter, while repeated calls without new live permissions in the current scope share that cancellation without advancing `permissionEpoch` again. Rotating `permissionEpoch` does not rotate the `RuntimeFence` or abort an unrelated natural model stream. `session.abort()` always calls `coordinationScheduler.cancel()` and additionally calls `runtimeLifecycle.cancel()` (rotating the runtime epoch) only when an active admission-bound run is in flight; idle or unbound `abort()` calls do not rotate the runtime epoch, and runtime replacement retires the old incarnation. If `cancelPermissions` fails while disconnected, local suppression still takes effect immediately and the pending cancellation is retried against the original adapter only on explicit `session.coordinationScheduler.reconcile()`.

`wait(target, deadline, signal)` takes an absolute epoch-millisecond `deadline` cutoff evaluated by the authority and returns a correlated `WaitOutcome` (`matched` with an `ExternalEventReference` only, `timeout`, `unanswerable` with `"parent-closed"` or `"answer-deadline"`, or `interrupted` with `"cancelled"` or `"runtime-detached"`). Timely facts recorded through the cutoff win over timeout; addressed `reply` waits become `unanswerable` on parent closure or answer-deadline expiry; and once an authoritative terminal wait outcome is recorded, a late reply or callback cannot revive or overwrite it. Private event bodies are never embedded in tool results: `matched` stages its reference into `RequestAdmission` for the next turn, while `timeout` and `unanswerable` are ordinary tool outcomes that may resume the healthy current run once (never granting new idle wake permission). The wait ticket remains cancellable until the next owned assistant start or run settlement.

`grant(target, signal)` registers one-shot wake permission for a `job`, `idle`, or `reply` target. Multiple eligible grants coalesce into one `WakeClaim` across final-text settlement and idle activation. Wake runs start from finalized context without fabricating synthetic user prompt messages. Ordered admission atomically consumes any grant whose event is admitted, including when a natural user request admits the event first (`consumedGrantIds` tombstones preserve consumption even if an in-flight armed receipt resolves out of order). If a claimed wake target cannot be admitted or is removed by final context or budget checks, its grant is marked with a sticky `blockedReason` so repeated refreshes do not loop; partial-success wake commits emit one body-free non-transcript UI notice and require an explicit user prompt or a fresh grant after cancellation.

Synchronous gates hold new automatic starts during user input preflight, runtime compaction (`compact()` and threshold auto-compaction), branch navigation (`navigateTree`), and extension UI interactions. Compaction and branch summarization include only admitted history and exclude unread local canonical events. Explicit `reconcile()` repairs committed admissions and flushes pending permission cancellations without automatically starting or replaying a wake run.

Real adapter/service authority and durable records are caller responsibilities. This capability does not supply job or helper launch, checkpoint batch finalization, process cleanup, global notification or results UI, live inference, or product/P0 readiness. Cache warming remains suspended while coordination-bound under the accepted Phase 4 limitation, and there is no session-format version change or credential serialization. See [Extension Coordination](coordination-extensions.md#wake-and-continuation-arbitration), including [pre-routing input observers](coordination-extensions.md#pre-routing-input-observers-and-gate-ownership) and [physical Escape cancellation](coordination-extensions.md#physical-escape-coordination-cancellation).

## Managed processes

`managedProcessCapabilities` advertises the frozen `managed-processes/1` descriptor: fd gates, `kinfo-us-v1` identity, service-cleanup retention and an attributed boundary. `assertManagedProcessSupport(session)` checks it together with the complete `session.managedProcesses` facade (`bind`, `reconcile`, `captureAttemptVersion`, `reconcileAttempt`, `inspect`, `requestStop`, `managedSpawn`). Bind one adapter per participating saved runtime with `session.managedProcesses.bind(adapter)`. Binding requires a lifecycle with a saved conversation that has called `participate()` (see [Runtime lifecycle coordination](#runtime-lifecycle-coordination)), and it fails on a retired runtime. Supporting the capability does not imply that a service accepts registrations, that Stop is enabled, or that any process is contained. Extensions see the same capability through [Managed Local Processes](extensions.md#managed-local-processes).

Pi keeps a process-lifetime journal of every attempt and spawn in the shared runtime host. It outlives tools, aborts, runtime retirement and extension reload. An adapter implements `proveHost(auth, readSelfBirth)`, `open(input, fence)`, `register(intent, fence)`, `coverage(input, fence)`, `callEnd(input, fence)` and `reconcile(page, auth)`.

`open`, `register`, `coverage` and `callEnd` receive the original captured fence as a separate argument; never recapture a newer runtime's fence inside them. An invocation made while the service was unreachable keeps its original host, instance, incarnation and conversation and is replayed later with host authentication. `proveHost` receives a callback, not a cached birth: request the service's one-use challenge, call `readSelfBirth()` immediately, then submit the assertion for comparison with the service's fresh native observation. A null result must refuse the rekey, and a PID-only fallback is prohibited. An adapter may cache a successful proof only within the same host and connection.

A journal page is a discriminated `records` array of latest attempt images, spawn images and tool-scoped gaps; a gap has no spawn id or PID. Each attempt has exactly one latest image, kept at its stable creation ordinal ahead of all its dependent records. Changing an image keeps its ordinal and advances a separate host `through`; a spawn's inner and outer ordinals agree. Every finite snapshot starts after 0, repeat snapshots included. An intermediate acknowledgement names the last record ordinal and the final one names the image `through`; ordinals may be sparse. A page has a fixed `through`, at most 32 records and at most 240 KiB, which leaves room for transient authentication under the 256 KiB wire bound. Records added after an image was frozen wait for the next reconciliation. After a lost response, retry the exact operation with identical bytes.

Host credentials and fences that carry a generation token are never journal fields, environment markers, model results or session JSONL. Child exit, `callEnd`, a replay acknowledgement and an uncertain cleanup receipt never delete a spawn root. Only an accounted cleanup receipt with a higher revision, naming retained ids of the same attempt, moves roots to tombstones. At 4096 unresolved roots pi keeps every root, records a sticky `journal-overflow` gap and lets ordinary work continue without managed acceptance.

`inspect().through` is the local image revision; `inspect().reconciledThrough` is the last COMPLETE acknowledged frozen image, never a partial page ordinal. To drain evidence for a stop or finalization, call `const target = managed.captureAttemptVersion(attemptId)` synchronously after the local latch, then `await managed.reconcileAttempt(target)`. The result `{ attemptId, version, through }` names a complete acknowledged image that covers the target, after draining any older frozen retry. It does not wait for sibling attempts to go quiet. A cleanup tombstone can advance the local revision without being transmitted, so it cannot advance this watermark. Retry certificate and receipt payloads with the frozen `through` that was returned, never a later `inspect()` value. Neither watermark seals a live host against later launches: finalization, and closing every continuation, belong to the supervisor's finalization protocol, not to a replay acknowledgement.

`requestStop(attemptId, stopId)` targets one attempt and returns `{ requested: true, settled }` synchronously, after latching the attempt, closing its unreleased gates and cancelling its local work. Acknowledge `requested` to the service before waiting for `settled`, so the service can run its own TERM, grace period and escalation. A later `stopId` for the same attempt reuses the latch. Pi sends no OS signal of its own to a stopping attempt.

## Examples

| Example | Purpose |
|---|---|
| [External events](../examples/sdk/15-external-events.ts) | Project logical external event state |
| [Runtime lifecycle](../examples/sdk/16-runtime-lifecycle.ts) | Participate and reconcile host runtime lifecycle |
| [Request admission](../examples/sdk/17-request-admission.ts) | Bind ordered request admission |
| [Coordination scheduler](../examples/sdk/18-coordination-scheduler.ts) | Bind wake and continuation arbitration |

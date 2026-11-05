# Extension Coordination

Extensions reach the session coordination capabilities through `ExtensionAPI` and `ExtensionContext`. Interactive mode also cancels coordination permissions on a physical Escape key press before any component receives it.

[SDK Coordination](coordination-sdk.md) describes the capabilities and their SDK contracts. [Coordination in Sessions](coordination-sessions.md) covers session files, the session tree, and compaction.

## External event projection

`pi.externalEventCapabilities` advertises the frozen `logical-external-events/1` descriptor. Use `assertExtensionExternalEventSupport(pi)` for the extension surface; the SDK session surface uses the distinct `assertExternalEventProjectionSupport(session)` guard and also requires `getExternalEventView`. Before saved mailbox participation, separately check `assertRecordSupport(ctx.sessionManager)`. An ephemeral or read-only inspection is not mailbox registration authority.

`pi.refreshExternalEvents(update)` forwards a complete verified snapshot or a disconnect update to the current session. The integration allocates monotonically increasing revisions per session. Missing items become unverified; a disconnect retains cached dispositions as unverified, and expired pending items are conservatively expired and unverified. A no-argument call invalidates the view without allocating a revision or changing its verification. Refresh does not admit, acknowledge, start a turn, or change the editor. Stale extension APIs cannot refresh after session replacement.

The capability does not prove service admission, lifecycle ownership, or wake scheduling. Older Pi can read inert metadata but is not a supported projection integration; do not fall back to custom messages. Extensions can inspect raw metadata and are not sandboxed from unread content. See [SDK Coordination](coordination-sdk.md#logical-external-event-projection) and [Coordination in Sessions](coordination-sessions.md#durable-external-records-opt-in).

## Runtime lifecycle coordination

Check `assertExtensionRuntimeLifecycleSupport(pi)` during loading; it checks the bound getter without invoking it. In `session_start`, obtain `pi.getRuntimeLifecycle()`, explicitly call `participate()`, and await `reconcile(exchange)` using a caller-supplied cooperating transport. On connection failure call `disconnect()` and handle the error; do not fall back to custom messages or keystrokes. Core saved participation requires `durable-records/1`. A full mail adapter also requires the independent `logical-external-events/1` capability.

```typescript
import {
  assertExtensionExternalEventSupport,
  assertExtensionRuntimeLifecycleSupport,
  assertRecordSupport,
  type ExtensionAPI,
  type RuntimeExchange,
} from "@earendil-works/pi-coding-agent";

export function configureLifecycle(pi: ExtensionAPI, exchange: RuntimeExchange) {
  assertExtensionRuntimeLifecycleSupport(pi);
  assertExtensionExternalEventSupport(pi);
  pi.on("session_start", async (_event, ctx) => {
    assertRecordSupport(ctx.sessionManager);
    const lifecycle = pi.getRuntimeLifecycle();
    lifecycle.participate();
    try {
      await lifecycle.reconcile(exchange);
    } catch (error) {
      lifecycle.disconnect();
      throw error;
    }
  });
  pi.on("session_shutdown", async (event) => {
    if (event.reason === "quit") await pi.getRuntimeLifecycle().reconcile(exchange);
  });
}
```

Core has already retired the old facade before `session_shutdown`. The handler can still obtain that retired facade and flush its host image before runner invalidation, but replacement adapters should defer the flush to successor startup to avoid a free-mailbox gap. Quit may flush. Neither action restores permissions. Old captured facades stay retired and old getters throw after invalidation. See [SDK runtime lifecycle coordination](coordination-sdk.md#runtime-lifecycle-coordination) for sensitive tokens, failure semantics, and the limits of this capability.

## Ordered request admission

`pi.requestAdmissionCapabilities` advertises `ordered-request-admission/1`. `assertExtensionRequestAdmissionSupport(pi)` checks the descriptor and the API's own dynamic getter without invoking it, so it is safe during extension loading. The getter `pi.requestAdmission` and `ctx.requestAdmission` resolve the current active runtime facade. Do not bind at module load: first establish a saved session and an active lifecycle attachment, then bind the caller's adapter from the current runtime. Old APIs become stale after replacement; do not retain their facade for a new runtime.

Admission, durable records, external-event projection, and runtime lifecycle are four independent capabilities. Check all four; metadata support is not participation, persistence, attachment, or authorization. The [SDK reference](coordination-sdk.md#ordered-request-admission) describes the checked bind helper, exported adapter types, finite snapshots, workspace basis, dispatch uncertainty, and the limits of the implementation. No helper or scheduler is started by these checks.

Context transforms and converters participating in coordination must preserve a candidate as one complete standalone message or remove it entirely. Pi decides admission from the final normalized context, not merely from staged slots. Coordinated `before_provider_request` / `onPayload` callbacks are observational only: in-place or replacement payload mutation stops the request. Auth, header, and payload guards rely on cooperative callbacks and providers; they cannot sandbox arbitrary extension side effects or prevent raw session metadata access. Ordinary unbound requests retain their normal behavior.

## Wake and continuation arbitration

`pi.coordinationSchedulerCapabilities` advertises `coordination-scheduler/1`. `assertExtensionCoordinationSchedulerSupport(pi)` checks the descriptor and the API's own dynamic `coordinationScheduler` getter without invoking it, so it is safe at extension load time. `pi.coordinationScheduler` and `ctx.coordinationScheduler` resolve the current active runtime facade and throw when accessed during module loading or after runtime replacement.

Bind `ctx.coordinationScheduler.bind(adapter)` only in `session_start` (or an explicit handler) after saved record support, external-event projection, runtime lifecycle participation, and verified attachment are established. Binding `coordinationScheduler` checks all five capabilities (`durable-records/1`, `logical-external-events/1`, `host-runtime-lifecycle/1`, `ordered-request-admission/1`, and `coordination-scheduler/1`) and owns `requestAdmission`; do not separately call `requestAdmission.bind(adapter)` on the same session.

```typescript
import {
  assertExtensionCoordinationSchedulerSupport,
  assertExtensionExternalEventSupport,
  assertExtensionRequestAdmissionSupport,
  assertExtensionRuntimeLifecycleSupport,
  assertRecordSupport,
  type CoordinationAdapter,
  type ExtensionAPI,
  type RuntimeExchange,
} from "@earendil-works/pi-coding-agent";

export function configureCoordinationScheduler(
  pi: ExtensionAPI,
  exchange: RuntimeExchange,
  createAdapter: (mailboxId: string) => CoordinationAdapter,
) {
  assertExtensionExternalEventSupport(pi);
  assertExtensionRuntimeLifecycleSupport(pi);
  assertExtensionRequestAdmissionSupport(pi);
  assertExtensionCoordinationSchedulerSupport(pi);

  let unbindScheduler: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    unbindScheduler?.();
    unbindScheduler = undefined;
    assertRecordSupport(ctx.sessionManager);
    const lifecycle = pi.getRuntimeLifecycle();
    lifecycle.participate();
    await lifecycle.reconcile(exchange);
    const { mailboxId } = lifecycle.capture();
    unbindScheduler = ctx.coordinationScheduler.bind(createAdapter(mailboxId));
  });

  pi.on("session_shutdown", async () => {
    unbindScheduler?.();
    unbindScheduler = undefined;
  });
}
```

Extension UI calls (`ctx.ui.select`, `confirm`, `input`, `editor`, `custom`) acquire tokenized coordination gates according to context ownership:
- Tool contexts (`createToolContext`) and active-run event contexts (`createContext` while a run is active, including `tool_call` permission handlers) capture `{ kind: "model", runId }`. `select`/`input`/`editor` hold `{ kind: "input", owner: "model" }` and `confirm` holds `{ kind: "permission", owner: "model" }` for that run's dispatch and new automatic starts. Calling a cached model UI object after its run has ended or after runtime replacement rejects.
- Command contexts (`createCommandContext`), keyboard shortcuts, and idle event handlers capture `{ kind: "user" }` and hold `{ kind: "utility", owner: "user" }` for new automatic starts only, without blocking an active run's current dispatch.
- `ctx.ui.custom` with `blocked: { kind: "question" | "permission" | "auth", message }` maps to model ownership (`input`, `permission`, or `auth`), holding current-run dispatch when a run is active or new starts when idle. Unblocked `custom` UIs (including overlays) hold `{ kind: "utility", owner: "user" }` for new starts only.

See [SDK wake and continuation arbitration](coordination-sdk.md#wake-and-continuation-arbitration) for permission vs runtime epochs, reference-only waits, one-shot grants, blocked-target behavior, nonactivating recovery, and implementation boundaries. Real adapter/service authority and durable records are caller responsibilities; no helper launch, checkpoint batch finalization, process cleanup, global notification/results UI, live inference, or product/P0 readiness is provided.

## Pre-routing input observers and gate ownership

`TUI.addInputObserver(observer)` (and `removeInputObserver(observer)`) registers a non-consuming `TuiInputObserver = (data: string) => void` on both `TuiMainScreen` and `TuiAltScreen`. Each terminal input packet is delivered to a snapshot of registered input observers after terminal color and color-scheme report responses are filtered, and before `addInputListener` handlers (which may consume or rewrite input), debug/viewport keys, key-release focus filtering, and overlay or focused-component routing. Observer return values are ignored and observer errors are not swallowed.

Interactive mode registers a single input observer on the terminal once, so it survives renderer mode switches and session replacements. When a physical Escape key press (`isCoordinationEscape(data)`, excluding key-release packets) arrives, the observer calls `session.coordinationScheduler.cancel()` before any listener, overlay, selector, dialog, or custom editor handles the key. Pressing Escape to close an overlay or custom screen revokes active coordination waits, grants, and pending wake activations without clearing editor drafts, restoring queued steering/follow-up messages, or aborting an unrelated natural model stream.

## Physical Escape coordination cancellation

Physical `escape` (`isCoordinationEscape(data)`, excluding key-release packets) is a fixed pre-routing coordination cancellation trigger in interactive mode, separate from configurable `app.interrupt`:
- Pressing physical `escape` calls `session.coordinationScheduler.cancel()` before terminal input listeners, overlays, selectors, dialogs, or custom editors receive the key, even if `app.interrupt` has been remapped or disabled in `keybindings.json`.
- When an overlay or custom component consumes `escape`, coordination waits, grants, and pending wake activations are revoked while the focused UI performs its normal close action and unrelated natural model streams, editor drafts, and steering/follow-up queues remain intact.
- Triggering a remapped `app.interrupt` key while the main editor has focus still cancels coordination permissions through `session.abort()`.

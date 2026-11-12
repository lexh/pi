# Managed Stop and Full-Batch Finalization

This page describes how pi ends a managed task: a stop that a supervising service confirmed, and a task's own declaration that it is complete. Both build on the `managed-processes/1` capability described in [SDK Coordination](coordination-sdk.md#managed-processes) and [Managed Local Processes](extensions.md#managed-local-processes). The capability is opt-in per runtime. Until an adapter is bound, ordinary tools, `pi.exec` and user `!` commands behave exactly as before. Below, `managed` is the `managedProcesses` facade of a session or of an extension context.

A gated command is started by a small shell that execs it, so a target that cannot be executed reports that shell's status and diagnostic. A missing path (a command containing a slash) exits with 126, and a missing command name exits with 127. A target that itself exits with 127 is an ordinary failure, never successful work.

## Stop

`managed.requestStop(attemptId, stopId)` targets one retained attempt. It latches that attempt synchronously, closes its unreleased gates, cancels its local work and returns `{ requested: true, settled }`. Before any cancellation or abort callback runs, the same call latches the attempt's task state in the shared runtime host, so nothing those callbacks do can still end the task as a success.

- Acknowledge `requested` to the service before waiting for `settled`. Pi sends no OS signal of its own to a stopping attempt; the service owns signals and every delayed local signal callback checks the stop latch.
- A later `stopId` for the same attempt shares the latch and its `settled` promise and never repeats the abort callback.
- After `settled`, capture the target version with `captureAttemptVersion(attemptId)` and `reconcileAttempt(target)`. The result names a complete acknowledged image that covers the stopping attempt.
- `acknowledgeStop(receipt)` hands each receipt to the adapter's `abortReceipt` with the attempt's own original fence, also when the attempt belongs to an earlier runtime of this process. It is never sent under a newer lifecycle capture.

## Full-batch finalization

A completion declaration is provisional until the whole tool batch of its turn has finished. A tool declares with `ctx.managedProcesses.declareTaskFinalization({ operationId, claim, declarationToolCallId })` from inside the declaring tool call, passing that call's own id. The declaration only stages; a terminating-tool hint or the declaring result alone ends nothing.

When the batch has finished, pi ends the task at the turn boundary, in this order:

1. The attempt is marked ended, synchronously. An ended attempt refuses new launches and managed activity.
2. The process-owned task book creates one certificate. Its journal watermark is read after the attempt ended.
3. The run's automatic continuation is suppressed: no further provider request, no `agent_before_settle` continuation and no settlement claim for this run. For an ended helper the same holds for every later wake, idle reconsideration and deferred settled action.
4. The certificate is sent through the adapter. The run waits at most one second for the answer. An unanswered certificate stays pending in the book and pi raises a warning notice.

The certificate preserves the declared `claim` (`claimed-success` or `claimed-failure`) verbatim. Its `toolResults` separately retain every sibling's `isError`, and `declarationBeforeResults` records whether sibling results exist next to the declaration. A failing sibling neither downgrades a success claim nor invalidates the certificate, and successful siblings never promote a failure claim. A failed or missing declaration result, duplicate tool-call ids, an abort or an assistant error cannot finalize either claim. A stop latched before the boundary outranks any declaration: the declaration is dropped.

## Sending and recovery

Sending requires the attempt's original run id and its local ended latch. The owner then captures the attempt's journal target, drains any older frozen replay, waits for a complete acknowledged image that covers the ended attempt and freezes one wire certificate that carries that image's `through`. The wire certificate lives in the attempt's process-owned state, so these hold:

- A reload, a lost response, cleanup tombstones and a sibling attempt that keeps spawning cannot change a sent payload. Every retry sends the same operation with identical bytes.
- Pi never waits for host-wide quiescence and never recaptures a successor runtime's fence. The adapter sends over the host-authenticated retained route, and no credential or fence is part of the certificate.
- The adapter answers `committed` or `superseded`. Either consumes the pending certificate. `superseded` means a stopping or fatal winner was recorded first and the requested outcome was not applied. Any other answer is an error and keeps the certificate pending.

A reloaded runtime holds no adapter until the integration binds one again. After `participate()` and `bind(adapter)`, `managed.reconcileFinalizations()` delivers every pending certificate. `session.reconcileTaskFinalization(commit)` delivers the pending certificate of the conversation's current task through a route the caller supplies instead.

## What ends automatic work

- A stopped or finalized helper task ends automatic work for its whole conversation, permanently. It stays ended whatever attempt is selected afterwards and whether or not a run is active.
- A stopped or finalized inline task ends only its own claimed run. A later wake starts a fresh attempt, and an ordinary run without a bound adapter is never vetoed by it.
- A helper task is a claimed run that its integration admitted as a helper's. Every other claimed run is an inline task.

Cleanup is separate from outcome. A run that ended without any declaration can still have its roots accounted: the adapter's `reconcile` returns cleanup receipts, and a receipt retires only the roots it names. Finalization decides the claimed outcome and ends automatic work; it does not decide whether work is still running.

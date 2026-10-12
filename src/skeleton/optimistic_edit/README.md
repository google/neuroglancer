# Spatial skeleton optimistic queue

This is the maintainer guide for optimistic editing of spatially indexed
skeletons. It describes the datasource-neutral engine, complete-snapshot
storage, inspected-input boundary, authority lane, failure policy, and CATMAID
integration.

The optimistic queue is the only editing architecture for writable spatially
indexed skeleton sources. Queue, history, projection, identity, scheduling,
and Reload-required state are generic. A datasource supplies only the logic
needed to describe and persist its workflows.

## Runtime structure

```text
EditableSpatiallyIndexedSkeletonSource
  -> optimisticEditing.createDriver({ source, identities, provisionalIds })
                       |
                       v
SpatialSkeletonState (one per layer)
  - queue engine and canonical intent journal
  - projection runtime and logical identity service
  - projected command history
  - immutable Reload-required latch
                       |
                       v
SpatialSkeletonOptimisticQueueEngine
  validate inspected source -> admit -> acquire inputs -> prepare exact preview
          -> acquire scope lane -> mutate authority
          -> adopt authority -> settle history -> release lane
                       |
                       v
datasource workflow driver and mutation adapter
  - immutable workflow recipes
  - under-lease request materialization
  - result interpretation and authoritative reconciliation
```

One logical intent is an Execute, Undo, or Redo transition. A compound intent
may have several physical steps, but it keeps one authority lease for those
steps. Distinct intents release the lease and enter the scope FIFO separately.

Generic optimistic-edit modules must not import `src/datasource`. Datasource
recipes and transport results are opaque at the generic boundary. A datasource
does not own queue lifecycle, command history, dependencies, identities,
projection publication, scheduling, or fatal state.

Queue, projection, and history capability methods are mandatory at their
generic ports. Callers do not probe for optional methods or silently substitute
fallback behavior. A missing capability is a construction/type contract error,
not a second runtime mode. Command factories receive only their action payload;
they do not receive the layer. Execution wrappers forward the required
`acceptedByQueue` and `settled` promises rather than infer authority settlement from
the earlier exact-preview promise.

Layer action availability validates the datasource's editing contract and its
driver registration. Command dispatch trusts that contract, checks the current
read-only/fatal gates, and resolves the requested factory; it does not repeat
the full source-shape check. Driver installation still validates a new
registration before replacing an existing engine.

Public commands and tools use `SpatialSkeletonOptimisticEditExecution<T>`
directly: ordinary edits use `T = void`, while Undo/Redo use `boolean`.
`withPendingMessage` decorates an execution for Add/Delete/Split/Merge. Its
message ends when the preview promise completes. Both `commands.ts` and
`queue_admission.ts` import `withPromiseProperties` from `src/util/promise.ts`
to attach caller-supplied properties to a promise and preserve their inferred
types. The callers supply `acceptedByQueue` and `settled`, including when
`finally()` produces a replacement preview promise. The utility also exports
`createDeferred`, which creates a promise with externally accessible resolution
and rejection functions. It has no skeleton dependencies. The queue admission
boundary observes independent acceptance rejections; the message wrapper does
not add a duplicate handler.

`prepareAndSubmitSpatialSkeletonEdit` submits a reusable input policy immediately.
The engine checks capacity and synchronously validates/pins required inspected
inputs, then registers the journal record, history transition, sequence, and
Preparing state before starting any read. `describeIntent` supplies the label
and optional preparation cue without reading topology.

At the ordered preparation frontier, the policy resolves current logical IDs and
node ownership, then acquires fresh complete snapshots. `prepareQueueInputBindings`
pins cached inputs, loads missing permitted inputs, and validates endpoints,
cache revisions, and the fatal gate after every read. `createQueueInput` deduplicates
the resulting snapshot bundle. The driver compiles its exact projection and
workflow exclusively from that bundle. Required-source validation is an admission
gate; it does not freeze the old source version for a later queued action.

An input reference keeps its current snapshot available against inactive-cache
eviction, without locking it or copying it for each consumer. Replacement or
invalidation makes the reference stale. `releaseInputReferences` removes this
preparation step's cache-retention registrations after preview completion or
failure. Other consumers keep their own references; unused data becomes eligible
for cache eviction. Missing-input reads have independent request owners, share an
existing fetch when possible, and survive inactivity while awaited.

`SpatialSkeletonState` stores this data in browser memory. `fullSegmentNodeCache`
maps segment IDs to complete node arrays. `fullSegmentSnapshotHandles` maps the
same IDs to immutable snapshot handles and local cache revisions. For example,
skeleton 23 can have nodes 1 and 2 in the array and snapshot H10 at revision 10.
After a Move, the current array contains node 2's new position and the snapshot
entry contains H11 at a newer revision. A consumer holding H10 still sees the old
position. Handles and arrays can share node objects; these are not necessarily
two full copies of the data. `queueInputReferenceRegistrations` records which current snapshots
preparation steps are keeping available. Releasing a reference removes its
registration, not the skeleton data itself.

H10 and H11 here are example labels for `CompleteSkeletonSnapshotHandle`
objects, not generated IDs. A handle exposes one complete skeleton version
through methods such as `getNode(nodeId)` and `materialize()`. The snapshot cache
stores one current handle/revision pair per segment. The registration map stores
one token per acquired input reference, pointing to the pair it acquired. Two
preparation steps can register different tokens for the same snapshot; releasing
one token leaves the other registration in place. A registration protects only
its exact current version from inactivity eviction; it does not prevent another
edit from replacing that version.

Acceptance and settlement are exposed independently of the exact-preview
promise. `acceptedByQueue` resolves once registration succeeds, before input
loading begins, so tools can release their interaction and admit the next action.
Synchronous admission failures reject acceptance and the preview promise with an
unchanged / not-started settlement. After registration, the queue owns input
preparation failure, suffix cancellation, and final settlement. The wrapper
forwards those promises independently.

## Snapshot, delta, and history

Keep these three concepts separate:

```text
Snapshot = the complete skeleton state at one point
Delta    = one requested transformation of that state
History  = ordered forward/inverse recipes for Undo and Redo
```

A complete snapshot is stable immutable input. It provides the topology and
attributes needed to:

- calculate a complete exact preview immediately;
- derive the exact inverse of an edit;
- partition or combine topology for Split and Merge;
- prepare a later edit over an earlier unconfirmed preview;
- atomically roll back or refold projected state.

A delta is not a replacement for that input. For example, `split at B` cannot
derive the two resulting components unless it can inspect all of `A -> B -> C`.
Conversely, history does not need to retain every internal projection link. It
retains an independent forward/inverse recipe for each undoable transition.

### Bounded snapshot projection depth

Complete snapshot handles may use lazy projections internally:

```text
S0 = inspected base snapshot
S1 = Patch(S0, edit 1)
S2 = Patch(S1, edit 2)
...
```

Without a bound, a long editing session leaves the newest snapshot traversing
every predecessor even after older history entries have expired. History
capacity does not break these internal references.

Every complete snapshot therefore has a private projection depth:

- a base or indexed flat projection has depth 0;
- patch, split view, and remap add 1 to their source depth; and
- merge has 1 plus the maximum component depth; its optional node-override
  patch wrapper adds one more level.

The private rebase threshold is 64. It is deliberately independent of queue
capacity, Undo/Redo history capacity, Recent activity, and the 24-segment
retained-overlay limit.

When a projection at depth 64 or greater is materialized, the handle:

1. materializes its complete frozen node array;
2. builds a node-ID index over that same array;
3. replaces only its private projection with an indexed flat projection; and
4. resets its private depth to 0.

Flattening preserves the public handle, kind, contents, node objects,
and any previously returned materialized array. First materialization builds
one array; rebasing reuses it and does not build another. The handle remains
publicly value-immutable even though its private storage changes.

Before deriving patch, split, merge, or remap state from a source already at
or above the threshold, materialize that source so the new child starts from
the flat checkpoint. An existing child created earlier remains correct because it kept
the immutable projection it was given. Future children use the checkpoint.

The threshold is not a strict maximum depth of 64. For example, merging a
depth-63 input with node overrides can produce depth 65: the merge and override
each add a level. That handle flattens when materialized or before another
operation derives from it. Rebasing does not contact CATMAID, alter the
skeleton, or clear history. Older snapshots may remain retained by other
owners, including history.

For a chain of one-level patches with materialization at each boundary:

```text
S0 -> ... -> S64-flat -> ... -> S128-flat -> ... -> S192-flat -> ... -> S200

S200 has only eight lazy levels after the S192 checkpoint.
```

Flattening at every edit would add O(nodes) work to every action. Rebasing on
history eviction would couple two independent subsystems and require rewriting
all retained descendants. A periodic local checkpoint bounds traversal while
performing O(nodes) index construction only at the boundary.

### Undo and Redo across a checkpoint

Internal rebasing has no Undo/Redo semantics. Consider:

```text
S62
  + forward 63 = S63
  + forward 64 = S64-flat
```

Undo remains LIFO:

```text
S64-flat
  + inverse 64 = state equivalent to S63
  + inverse 63 = state equivalent to S62
```

Undo 64 reconstructs the state against which inverse 63 was defined. Undo 63
then applies its independently retained inverse recipe; it does not walk the
discarded `S64 -> S63` storage link. Redo applies forward 63 and forward 64 in
the opposite direction. The reconstructed snapshots may be different handles,
but topology, attributes, logical identities, and authoritative mappings must
be equivalent.

If edit 63 has expired from bounded history, it cannot be undone regardless of
snapshot rebasing. There is no selective Undo that skips edit 64.

## Generic inspected-input boundary

Commands declare two input groups: `required` must already have a complete
inspected snapshot at admission, while `loadable` may be fetched inside the
queue's Preparing phase. A node visible only through a spatial-index chunk is
insufficient for a required input. Every listed input is needed.

All public Execute actions use this policy. Capacity, inspection validation,
sequence allocation, journal registration, and projected history happen before
asynchronous input loading. `acceptedByQueue` therefore resolves without waiting
for topology reads; the execution promise still waits for the exact preview.

An action with deferred inputs conservatively depends on all earlier active
layer intents. Preparation waits for their exact previews, then captures the
current projected snapshots and owning skeletons. Later actions cannot overtake
a loading action, even when their own inputs are cached. This barrier orders
preparation within a layer; it does not change the shared project mutation lane
or serialize preparation across layers. Warm previews still run on microtasks
without waiting for earlier server responses.

The generic preparation policy pins cached inputs, loads missing inputs
sequentially, and rechecks references, endpoint declarations, and the fatal gate
after each read. Repeated endpoints in a loaded skeleton reuse its cache. The
bundle follows `required` then `loadable` order and deduplicates skeletons.
Cancellation releases the intent's read owners and references; shared consumers
keep their own ownership. Late canceled read results cannot revive the intent.
An unexpected revision or endpoint change fails preparation. If an earlier
queued save publishes its authoritative correction during loading, the engine
reacquires inputs from that corrected state before compiling the preview.

Undo and Redo normally use retained history recipes without fetching topology.
Undo can also cancel an admitted action before it has a recipe or inverse, with
no mutation request. Redo of that unprepared action reacquires complete inputs
through the original policy, including a previously inspected source evicted
while the action was canceled. Its first exact publication retains the recipe
for subsequent Undo/Redo. Input failure rolls back the failed transition and
cancels the later queue suffix under the existing failure policy.

The TypeScript command descriptor is trusted. There is no runtime assertion
rejecting old callback names or validating its action/label/payload shape.
Actual snapshot, endpoint, cache-revision, and fatal-state checks remain, as do
datasource payload validation and copying/freezing.

The engine passes Execute drivers one datasource-neutral bundle:

```ts
interface SpatialSkeletonQueueSegmentInput {
  readonly segmentId: number;
  readonly snapshot: CompleteSkeletonSnapshotHandle;
  readonly cacheRevision: number;
}

interface SpatialSkeletonQueueInput {
  readonly segments: readonly SpatialSkeletonQueueSegmentInput[];
}
```

The outer object, segment array, and segment records are frozen. Snapshot
handles are not recursively frozen because they maintain private materialized
state. Records are deduplicated in queue-input requirement order. Repeated
requirements for one segment must resolve to the same handle and cache
revision; conflicting duplicates are a contract failure. Root creation
receives an explicit frozen empty bundle.

Input references remain held until the exact-preview promise resolves or
rejects, then release before authority settlement. Preview preparation must
use only the retained bundle. Hydration is owned by the generic queue input policy; there is no direct
manager/cache lookup in a datasource driver.

CATMAID declares only the destination of a newly requested Merge as `loadable`.
The source must already be inspected. The destination uses a shared fetch with
a 120-second deadline. While it loads, the intent is visible as Preparing, its
history transition is available to Undo, and the coarse merge preparation cue
is shown. A complete exact preview and mutation wait for validated inputs.
Failed or timed-out reads are cleared so a later user action can try again.

While an edit or the merge-target prefetch awaits a full-skeleton read, that
read starts before display reads waiting in the concurrency limiter, including
a display read it joined while queued. Once nothing awaits it, it waits its
turn again. While a merge anchor is set, the edit tool also
prefetches the skeleton under the pointer (`skeleton_merge_target_prefetch.ts`)
and protects the loaded snapshot from eviction until the target changes, so the
second pick usually admits synchronously.

Root creation has no existing input. Restoration of a deleted one-node
skeleton is root-like. Other CATMAID Execute actions use only `required` inputs.

A drag captures the selected node's logical handle at mousedown. Each pointer
move resolves its current node ID, and mouseup uses its current cached node and
owning skeleton when constructing the Move command. An earlier creation, Split,
or Merge may be acknowledged during the gesture; the captured physical IDs and
node snapshot must not be reused for submission. This also covers acknowledgement
before the drag threshold or after the last pointer movement.

Radius, Description, and Confidence keep their focused controls and view contexts
intact. While the same logical node and editing runtime remain active,
selection-details views (including ancestor views) defer rebuilds until user blur.
This preserves native text Undo/Redo, textarea selection, the Radius spinner's
pending 500 ms save, and keyboard focus in the Confidence dropdown. Copying the
text or moving the textarea to a replacement view would lose native Undo history.
The draft-copying helper is therefore removed.

The rest of the application continues to publish previews and acknowledgements;
the selection-details view catches up with the latest model on blur. Property
commits and node actions resolve the logical node to its current cached node, so
permanent-ID assignment cannot redirect an edit to the old provisional ID.
Description, Radius, Confidence, and True End also use that current node for
unchanged-value checks. Switching between protected editors can preserve the
same view across several edits or a rejected preview; render-time values and
last submitted values are not reliable comparisons. Restoring the original
Description must save, and retrying a rejected Radius must compare against the
rolled-back value. Returning Confidence or True End to the value already restored
by rollback creates no action and preserves any valid Redo branch.
A different selection or source, deletion, or Reload required invalidates the
focus guard and allows the view to rebuild. Closing the view disposes its
listeners and pending saves normally. Unregistered controls keep the existing
redraw behavior.

The Skeleton tab's Undo/Redo buttons use the same queue eligibility queries as
action dispatch, with command history supplying the labels. Reload required
keeps both buttons disabled and supplies their explanatory tooltip.

State-owned Undo/Redo dispatch checks eligibility before calling the engine.
An unavailable transition creates no queue entry, history ticket, or server
request, including when reached through a shortcut or direct API call. The
state returns its existing completed `false`/unchanged-no-op execution; public
command wrappers do not construct a second fallback result.

When a primary pointer press starts inside the protected skeleton details
container, or a view containing a protected focused editor, that view and its
ancestors also defer rebuilding through pointer release. The container guard is
registered once and shares the property editors' selection/source validity check.
This is captured before blur: saving a draft on blur can dirty a previously clean
view. Rebuilding on the next frame while the mouse is still down would remove
the pressed button and lose its click. After pointerup the next animation frame
applies the latest model, allowing the intervening click to finish normally.
Pointer cancellation, window blur, view disposal, or invalidating the editor also
release the press. The guard applies only to opted-in views, with no fixed
click delay or synthetic click dispatch.

A drag also captures its interaction generation. Deactivating the edit tool
invalidates its pointer-move and mouseup callbacks, clears the gesture preview,
and releases its temporary browse exclusion and cursor. Reactivating the tool
does not revive the abandoned drag; only a new gesture may submit a Move.

Preparation cues describe local preview computation. They do not carry a wait
reason for topology fetches or server acknowledgements: required inputs are
already inspected, and previews can use provisional identities. The Details
status matches either the selected physical ID or its logical identity across
remapping, without displaying temporary IDs.

The execution boundary has dedicated operations:

- `submitExecute(command, queueInput)`;
- `submitUndo()`; and
- `submitRedo()`.

Execute driver creation receives `{ intentId, intent: "execute",
queueInput }`. Undo/Redo creation receives `{ intentId, intent, recipe }`,
where the generic engine has already selected one exact `{ workflow,
projection, inverseProjection }` history recipe. Datasources receive no
history ticket or history lookup callback.

## Admission and projection publication

The high-level order is:

1. Check fatal state, capacity, and required-source inspection; pin cached sources.
2. Reserve an intent ID and stage the projected history transition.
3. Register the description, input policy, conservative resources/dependencies,
   and any truthful preparation cue in the canonical journal.
4. Resolve `.acceptedByQueue`.
5. Wait for preceding exact previews, acquire current complete inputs, and compile
   the workflow, fixed logical identities, and projection recipe.
6. Reduce and atomically adopt the exact preview.
7. Resolve the exact-preview execution promise and release input references.
8. Wait for the intent's layer order and acquire its mutation-scope lease.
9. Execute and reconcile the datasource workflow.
10. Adopt the authoritative result, settle history, release the lease, and
    resolve `.settled`.

Public Execute actions use a conservative layer preparation barrier while their
resources are unknown. They wait for earlier exact previews, then use current
projected inputs, without waiting for server replies. Retained history recipes
can prepare independently once their dependencies have exact previews. Physical
transport still follows strict intent order within each layer.

Every local publication follows one failure-atomic strategy: build the complete
candidate off-screen; check the action's local preconditions, cache revisions,
and identity bindings; prepare an immutable publication; adopt it synchronously
by reference; then emit one presentation revision. The manager materializes
changed snapshots once to build rendering and reverse-index data, but production
does not rescan the complete tree to validate reducer output. Adoption does not
invoke datasource callbacks or perform transformations that can throw. UI hints
such as selection, navigation, pinning, and long-lived visibility run afterward
as isolated best-effort effects.

## One FIFO authority lane per mutation scope

`mutationAdapter.mutationScope` is the only physical scheduling key. Each
scope has one global FIFO lane, so layer-owned engines targeting the same
authority cannot race. There are no physical node/segment/source resource
descriptors, resource-overlap calculations, resource expansion, or
CATMAID-specific serial scheduler.

Within a layer, authority starts in intent-sequence order and at most one
workflow runs at a time. Across layers, lease acquisition order is the scope
FIFO order. Preparation and exact preview are independent of that lane.

A compound workflow reuses its lease across all steps. A distinct intent,
including Undo or Redo, releases and reacquires so it cannot bypass older
cross-layer waiters.

Lease states are:

- `active`: the engine owns the scope lane;
- `retained`: Reload required permanently fences that scope for the page; and
- `released`: the next FIFO waiter may acquire the lane.

Once a scheduler transfers the lease to the engine, every scheduler outcome
returns it to the engine. Only the engine decides whether to release or retain
it after projection, journal, history, and UI state agree.

CATMAID interns `mutationScope` from normalized base URL and project ID. Thus
only one CATMAID mutation for a project runs at a time across layers. A second
layer can still prepare and display an exact preview while it waits. Other
mutation scopes remain independent.

## Definitive failure and history rollback

When no physical step has committed and the outcome proves the server unchanged:

1. Cancel the failed intent and every later nonterminal intent before transport.
2. Atomically remove their exact projections and replay earlier active projections.
3. Reject the journal suffix and call `history.rollbackFrom(failedTicket)`.
4. Synchronize retained-history ownership before settling the failed root with
   its real reason and later intents as `unchanged/not-started` with:

   ```text
   Canceled because an earlier edit was not saved.
   ```

5. Release the authority lease after projection, journal, history, and UI agree.

`rollbackFrom` removes the failed transition and all later staged transitions,
including out-of-order confirmations from locally canceled edit/Undo pairs.
It rebuilds projected Undo/Redo from the confirmed stacks and surviving earlier
transitions. Earlier in-flight tickets can still confirm normally. Later local
cancellation pairs keep their Reverted activity rows, but cannot reintroduce
history discarded by the failure.

A failed Execute restores the earlier Redo branch it cleared and any history
entries it displaced through capacity trimming. Failed Undo/Redo restores the
original edit to its source stack, where an explicit retry is available. A
failed original Execute never becomes a Redo retry. All later unfinished edits
are canceled, including edits to unrelated skeletons in the same layer.

Canonical recipes referenced by staged transitions must remain retained even
when absent from the confirmed/projected stacks and Recent activity. An earlier
in-flight save can leave a locally canceled pair staged while a newer Execute
hides its Redo entry. If that Execute fails, the pair's original recipe is needed
again. These temporary recovery references are released as transitions confirm
or are discarded; they do not enlarge the user-visible history capacity.

Missing rollback boundaries or failures restoring the local projection/history
require reload and reset the complete history. Since authority is unchanged,
the affected lease is released. Unknown outcomes and partial commits retain
their existing fatal reset and lane-fencing behavior.

A failure before canonical admission abandons only the newly staged history
transition and creates no Queue row or preview. History exposes only the
operations needed by this model: `abandonLatest(ticket)`, `rollbackFrom(ticket)`,
`confirm(ticket)`, and `reset()`. Confirming a discarded ticket is a no-op.

There is no dependency rebase, failed-Execute Redo retry, or mutable replacement
of dependencies. If any physical step has committed, a later failure
cannot be treated as a definitive unchanged outcome; it enters Reload required.
Every step must succeed before its exact preview can be confirmed. In
particular, a failed reroot after merge split-back requires reload because the
server has different or unknown topology.

## Reload required

Finite authority outcomes are committed, rejected, not-started, and
indeterminate.

- Rejected/not-started before any commit uses the definitive suffix rollback
  and history-rollback policy above.
- An indeterminate started transport may have changed authority. The engine
  latches `authority-indeterminate`, retains the scope lease, and leaves
  `.settled` pending until reload.
- A known commit that cannot be published locally latches
  `committed-local-publication-failed`, retains the lease, and leaves
  `.settled` pending.
- A later step that fails after an earlier compound step committed is
  also a committed local-publication failure, not a rejection.
- If a definitive local rollback/refold cannot be published, the engine
  latches `local-projection-reset-failed`. Authority is known unchanged, so it
  releases rather than retains the scope lane, but the layer still requires a
  reload because its visible projection cannot be trusted.

The first fatal reason wins. Fatal entry stops the pump, cancels every
pre-commit submission, removes its cue and preview in one refold, blocks new
Execute/Undo/Redo, retains an authority-unsafe faulting lease, and publishes
one persistent Reload-required notification. A local projection-reset fault
releases its definitively unchanged lane. Started transport is classified but
not aborted. No later workflow step starts after fatal entry.

Queue and Recent activity messages preserve each intent's recorded cancellation
reason. Unsent work canceled by a fatal state says "Canceled because another
edit requires a page reload." It does not imply that the faulting edit was
definitively rejected; that edit may have committed or have an unknown outcome.

There is no automatic recovery, mutation retry, topology-verification GET, or
scoped refresh. The Queue UI exposes one persistent `role="alert"` banner and
**Reload page** action. Inspection, selection, filtering, pinning, and
navigation remain available, but editing does not.

## Disposal

`engine.dispose(): Promise<void>` is idempotent. Disposal stops pumping,
cancels pre-commit submissions, removes preparation cues, atomically refolds
away unresolved previews, resets staged history, and settles unsent intents as
`unchanged/not-started`.

Disposal never sends an inverse mutation and has no compensation phase:

- a started transport that is definitively rejected settles unchanged and
  releases the lane;
- a committed result, or a workflow with any earlier committed step, latches
  `committed-local-publication-failed` and retains the lane; and
- an indeterminate result latches `authority-indeterminate` and retains the
  lane.

Datasource cleanup waits for classification and driver unwinding, but not for
the deliberately pending Reload-required `.settled` promise. A replacement
engine may prepare previews immediately. Its transport waits behind a retained
old lane when reload is required.

The old compensation-only workflow phases, mutation intent, lifecycle axes,
`compensated` settlement, `Reverting` state, and CATMAID reversal-on-disposal
logic do not exist. Ordinary explicit Undo/Redo remains supported. A
queued-opposite no-op may still be reported as a local **Reverted** activity;
it did not send compensation.

## Identity resolution during overlapping Undo/Redo

A logical handle can have a confirmed ID and several intent-owned provisional
replacements. They serve different moments in the queue:

- Baseline snapshots and ordinary authoritative reads use confirmed IDs.
- `mappings.clone(throughSequence)` creates an isolated candidate; zero excludes
  every provisional overlay. Identity-copy logic stays with mapping storage.
  Owner and overlay-token lookups read the mappings directly, without creating
  a candidate or copying every node binding.
- Preview replay starts from those IDs and stages each intent's provisional
  bindings immediately before reducing that intent. Future replacements are
  not visible to earlier deltas.
- Promotion uses the committed intent's mappings, excluding later overlays.
  Returned IDs remap that promoted snapshot; pending previews are then replayed.
- Request materialization uses `resolveAuthoritativeNode/Segment`, with results
  from earlier steps in the same compound workflow taking precedence. A preview
  alone never supplies a transport ID.
- Display remaps follow the final preview. An earlier response must not replace
  a later Redo's temporary node or skeleton ID. Active previews also own absence:
  a hidden confirmed snapshot must not reappear beside its replacement.

For Add → Undo → Redo with Add still saving, each action reuses the created
node's logical handle. Add's response supplies the real ID for Undo's delete
request. Redo keeps its own temporary ID on screen until its creation succeeds.
The same ordering applies to Delete's restoration and Split/Merge history.
This uses the existing confirmed mapping and provisional overlays, without a
second persistent identity store or extra server reads.

## No settlement-time verification

A validated mutation response plus retained complete queue input is the
authority proof. Reconciliation applies returned node/segment bindings,
retirements, and any projection correction, then adopts once. It does not call
`getSkeleton()` to verify topology.

There is no topology-refresh batch, expected-presence registry, verification
generation, retry/backoff timer, or background healing. Split/Merge topology
comes from complete snapshots and returned IDs. Reroot uses the locally
derived topology. CATMAID edition timestamps are not retained in nodes, chunks,
snapshots, or reconciliation. Local cache revisions still reject stale reads,
including reads that arrive after confirmed retirement. Merge explicitly retires
CATMAID's deleted physical skeleton ID while retaining the logical aliases used
by Undo. Retirement advances that ID's cache revision even when the preview has
already removed its snapshot, and cancels retained reads. The revision check also
rejects responses from sources that ignore cancellation. A pending Undo can keep
its provisional replacement without reviving the retired physical ID.

Projection adoption does not invalidate spatial-index cells because the
datasource grid may still return stale data. The presentation records explicit
segment removals separately from cache eviction. Rendering discards removed
segments' GPU chunks, skips their complete reads, and suppresses their grid
copies even after they leave the retained overlay pool. A replacement snapshot
clears its removal; source/runtime reset clears all removals. Pending Undo can
therefore render a replacement ID while the deleted physical ID stays hidden.
Ordinary cache eviction still preserves the last rendered chunk during reload.

GPU geometry reuse compares immutable node-array identity and the drag-position
key. Snapshot handles have no revision or version counters; their immutable
identity and contents are sufficient. Manager cache revisions and logical
mapping revisions remain necessary to fence asynchronous reads and publication
adoption.

New CATMAID nodes explicitly start with radius 0 and confidence 0%, matching
creation defaults. Captured history therefore retains the original root's
confidence even before a complete backend read. Reroot and non-root Merge Undo
restore that value after CATMAID resets a rerooted root to 100%.

CATMAID description normalization can return an empty value. Reconciliation
adopts that value and retains it in canonical Undo/Redo recipes, including when
input contains only whitespace or reserved end labels. Reroot resets the new
root's confidence to 100%; inverse reroot and non-root Merge restoration add a
confidence write when the original root had a different value. All inverse
steps share the workflow lease and must finish before Saved. A Merge attachment
that is already a root keeps its existing confidence.

CATMAID can reverse a Merge's direction. During authoritative publication, the
runtime refolds active previews in order and lets the engine rebuild queued
Undo/Redo recipes from the finalized action and earlier refolded artifacts.
Their projection, provisional bindings, and workflow are updated together;
failed preparation does not publish the candidate. CATMAID history takes
Reroot's and Merge's original root and confidence, Split's former parent,
Delete's restored connections and node values, and Confidence's previous value
from the canonical inverse. Undo therefore saves the same topology and properties
that it previews after an earlier Merge changes direction, including repeated
Undo/Redo with replacement node and skeleton IDs.

For example, merge A with B, then queue a Merge of that combined tree under C.
If CATMAID reverses the first Merge, Undo of the second must restore the corrected
root of A+B, including its confidence. The Merge recipe retains one restoration
root from the canonical inverse instead of choosing between roots captured at
admission. A forward Merge gives its distinct output handle an intent-owned
provisional numeric ID, just like Split. It never borrows an input's ID: a
pending Create, Split, or earlier Merge can receive a different saved ID without
moving the merged snapshot away from its visible overlay. The ordinary mapping
overlay commits the output to CATMAID's surviving ID when Merge saves, or is
discarded on rollback. Until then the merged skeleton is shown as **Preview**.

If the reply arrives during Undo/Redo preparation, the engine discards the
outdated candidate and prepares the current history recipe before publication.
Presentation remaps follow the final preview's logical owners. Each numeric
remap is applied once, so exchanging which skeleton owns a provisional ID
does not collapse both restored overlays onto the merge survivor.

Logical identity-map garbage collection and notification-deduplication set
bounding remain deferred.

## CATMAID boundary

CATMAID builds Execute recipes exclusively from `queueInput`. Its driver
does not retain a layer reference and does not read manager/cache state.
Provider context retains `source`, logical identities, and provisional-ID
allocation, but not `layer`.

The generic queue admission boundary still supplies complete immutable snapshots.
Each datasource chooses which logical node identities and authority data its
opaque recipe retains. CATMAID binds only the nodes needed by the action and
materializes scalar endpoint arguments under the authority lease; another
datasource may deliberately bind or materialize a complete graph.

CATMAID-specific responsibilities include:

- immutable workflow/request and inverse recipe construction;
- authoritative ID resolution immediately before transport;
- endpoint-specific scalar payload and `nocheck` policy;
- response validation and authoritative identity mapping;
- split, merge, reroot, and compound workflow interpretation; and
- finite transport failure classification.

Insert is an optional source command capability. CATMAID captures the parent and
children from the admitted snapshot and uses its existing created-node workflow,
with an insert transport step and the compact `restore-delete` projection.
Undo deletes the inserted node and reconnects its children; Redo inserts it again
using the current authoritative identities. No separate projection operation is needed.

CATMAID does not implement a queue, history registry, physical-resource list,
lease cursor, compensation workflow, direct cache lookup, or Reload-required
policy.

Important focused files are:

| File                          | Responsibility                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `command_payloads.ts`         | Command payload union, individual payload types, and datasource payload validation.       |
| `queue_input_requirements.ts` | Resolved skeleton/node requirements and loading policy for ordered queue preparation.     |
| `mutation_adapter.ts`         | Mutation scope, transport invocation, endpoint policy, and finite failure classification. |
| `mutation_scope.ts`           | Stable scope identity for normalized base URL/project.                                    |
| `workflow_recipe.ts`          | Immutable semantic recipes and forward/inverse step derivation.                           |
| `workflow_authority.ts`       | Under-lease request materialization and reconciliation.                                   |
| `workflow_driver.ts`          | Execute creation from generic queue input and Undo/Redo recipe interpretation.            |

## Generic file map

| File                             | Responsibility                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `api.ts`                         | Required provider registration, mutation adapter, and finite outcomes.                                     |
| `engine.ts`                      | Canonical intent lifecycle, history coupling, projection, scheduling, failure rollback, and fatal fencing. |
| `engine_runtime.ts`              | Promise, input cancellation/retention, submission, lease, and disposal sidecars only.                      |
| `engine_history.ts`              | Projected history operations over generic records.                                                         |
| `engine_read_model.ts`           | Queue and Recent activity presentation, including failure-reason formatting.                               |
| `ports.ts`                       | Datasource-neutral driver, projection, and history contracts.                                              |
| `projection_runtime.ts`          | Off-screen reduction, local guards, and atomic adoption.                                                   |
| `projection_workspace.ts`        | Pure snapshot and identity mapping helpers.                                                                |
| `authority_lease_coordinator.ts` | One global FIFO lane per mutation scope.                                                                   |
| `scheduler.ts`                   | Pre-commit cancellation and adapter outcome normalization.                                                 |
| `lifecycle.ts`                   | Lifecycle and settlement values.                                                                           |
| `host.ts`                        | Provider validation and connection to the state-owned engine.                                              |

Related generic files include `complete_skeleton_snapshot.ts`,
`queue_admission.ts`, `command_history.ts`, `logical_identity.ts`,
`spatial_skeleton_intent_journal.ts`,
`spatial_skeleton_projection_reducer.ts`, and the Queue tab implementation.

`logical_identity.ts` defines stable handles and their provisional/authoritative
ID mappings independently of queue records. The projection runtime owns the
mapping instance; the journal imports only handles and resource-key helpers.
Identity and journal tests live beside their respective implementations.

Engine subscriptions use Neuroglancer's `NullarySignal`. Notification dispatch
isolates each observer and its error reporter, so presentation failures cannot
interrupt an already-adopted edit or prevent later observers from being notified.
The engine keeps its existing `subscribe()` interface and asynchronous disposal.

## Testing

At minimum, cover:

- thousands of lazy patch levels without recursive failure;
- flat checkpoints at 64, 128, and 192 with stable handle, node-array, and
  unchanged-node identity;
- sequential Undo 64 then Undo 63, followed by Redo 63 and Redo 64;
- rebase-boundary move, attribute, split, merge, and authoritative remap;
- frozen/deduplicated inspected bundles, empty root input, input retention lifetime,
  cold Merge loading, conflict rejection, and no CATMAID cache lookup;
- same-scope FIFO, different-scope concurrency, per-layer intent order,
  compound lease reuse, and reacquisition between intents;
- definitive failure suffix cancellation and preservation of earlier history;
- disposal before transport, late rejection, late commit, ambiguity, and
  partial compound workflows with zero compensation POSTs; and
- Reload-required lease retention and replacement-engine behavior.

The Docker suite retains the following regression checks under its existing
case IDs:

- **01:** turning editing off during a drag discards the preview and sends no
  mutation, even if editing is reactivated before mouseup. Later pointer movement
  cannot revive that preview or add queue/history entries. A new gesture still
  saves normally, with Undo/Redo and reload checks.
  The same case holds a Move while typing a description. Its acknowledgement
  must preserve the focused control and native text Undo/Redo, without changing
  skeleton history or sending a description mutation. Typing continues, and only
  the subsequent blur saves the completed description;
  Undo restores its original value before the Move Undo/Redo and reload checks.
  Another held Move preserves a Radius draft without sending a radius mutation;
  blur without further typing then saves it exactly once, and Undo restores both
  the previous radius and coordinates. A spinner change during another held Move
  also survives acknowledgement: its existing debounce sends exactly one Radius
  mutation without a user blur. A before-request gate verifies preview/backend
  separation, followed by save and Undo of both changes.
- **04:** empty, whitespace-only, and reserved-label descriptions agree with
  CATMAID after save and canonical Undo/Redo.
- **06:** newly created nodes retain explicit property defaults through full
  Undo/Redo. Reroot and non-root Merge also restore their original root's 0%
  confidence through repeated Undo/Redo, held confidence writes, replacement
  skeleton IDs, and reload. Real graph comparisons do not substitute missing
  radius or confidence values. A separate step holds the real creation response,
  starts dragging its provisional root, and releases the acknowledgement before
  mouseup. The continued drag and Move request must use the permanent node ID.
  A new root's held creation response also checks a Description draft across
  permanent-ID assignment: the same control, text, focus, caret, and native text
  Undo/Redo survive, with no description request on acknowledgement. A 150 ms
  press on Delete saves the draft on blur, survives the deferred redraw, and
  targets the permanent ID from the retained view. Undo recreates the root with
  a replacement ID and its description; further Undo/Redo checks both edits
  across replacements before reload.
  A held Move checks preview/backend separation; Undo/Redo checks the original
  coordinates, recreation with another node ID, and the final coordinates on
  reload.
- **12:** a restored singleton has a real rendered chunk before Redo; that
  chunk disappears during the held deletion and remains absent after Saved.
- **13–14:** each Split Undo holds the Merge request, captures a real read of the
  downstream skeleton before CATMAID deletes it, and holds that response across
  confirmation. The deleted ID's revision advances, its retained read is canceled,
  and the restored topology remains correct after releasing the stale response.
  Both cycles still verify replacement IDs, Redo, and reload.
- **15:** merging at an existing root preserves its non-default confidence
  without an extra reroot. A real target-skeleton response captured during the
  pending Merge is held across confirmation and cannot restore the deleted ID.
- **16:** repeated non-root Merge Undo restores both original roots, including
  non-default root confidence. Separate gates hold split, reroot, and confidence
  restoration while the complete inverse is already visible.
- **18:** standalone reroot Undo restores non-default root confidence and stays
  Saving until that confidence write completes.

Unit tests cover removal publication atomicity, retained chunks versus cache
eviction, pending Undo replacement IDs, empty-description canonical history,
and confidence restoration after either Merge direction or root-ID replacement.
Merge retirement tests also cover a source that ignores cancellation, eviction of
the surviving skeleton before the stale response arrives, and preservation of a
pending Undo's provisional replacement and subsequent authoritative binding.
Six gesture regressions cover node-plus-skeleton and skeleton-only remapping,
each before movement, during movement, and after the last movement before mouseup.
Four more gesture regressions cover deactivation before and after movement,
with and without reactivation, and ensure stale callbacks cannot alter a new drag.
Dependent-view unit tests cover deferred inner and outer updates, repeated and
forced redraw requests, native-control identity and text selection, a pending
500 ms save, invalidation, normal unregistered/unfocused controls, and cleanup
of a closed view without a delayed save or redraw.
Pointer-press regressions also cover clean views dirtied by blur, already-dirty
ancestors, presses without a focused editor, unrelated pointer releases,
cancellation, invalidation, window blur, and disposal. Press protection is enabled
for the skeleton details container with the same selection/source validity check
as its property editors; unregistered views keep their existing redraw behavior.
Two mock-browser cases use a 150 ms press on Delete: one after editing Description,
the other after a Move acknowledgement deferred the redraw. A third releases a
held Move response between pressing and releasing Delete with focus initially on
the viewport. All three require the preceding save and Delete to commit exactly
once and remove the node from both the displayed and persisted graphs.
Two more mock-browser regressions retain the same property controls while
switching focus between Description and Radius. One saves, clears, and edits
Description again, checks that an unchanged blur admits no extra work, and uses
Undo/Redo. The other rejects Radius before the backend applies it, retries the
same value after rollback, checks the saved/not-saved activity rows and persisted
radius, and uses Undo to restore the original value. A Confidence regression uses
Tab to enter the dropdown while a Move response is held, then checks that its DOM
identity and keyboard focus survive acknowledgement. ArrowUp must subsequently
submit one confidence edit and persist the expected value.
Two rejection cases keep Confidence focused while either Confidence or True End
rolls back. Returning the control to the restored value must send no mutation,
add no queue entry, and preserve Redo of an earlier Description. The tests use
that Redo button, retry the rejected value successfully, and Undo the retry.
The pending-insertion regression exercises Delete → Undo → Split, ensuring a
later failed Split preserves the restored topology without a standalone Insert.
Three command regressions queue Delete, Split, or Confidence behind a held Merge
whose reply reverses its direction. They verify the corrected Undo payloads,
complete restored topology, confidence, repeated Undo/Redo, and replacement IDs.
Three mock-browser cases exercise the same sequences through the UI, compare
with the mock backend's saved graph, and reload. The mock reverses the actual
Merge request before reporting the direction adjustment; these cases do not
claim real-CATMAID coverage of automatic direction reversal. The mock's Merge
preserves confidence when its target is already a root, matching CATMAID's
no-op reroot path; a helper regression protects that behavior.
Two more command and two mock-browser cases queue a second Merge behind the
reversed first Merge, covering both orientations of the second join. They check
the corrected root and confidence, repeated Undo/Redo with fresh skeleton IDs,
and agreement between preview and saved topology after reload. The reversed
second-join case also verifies that a queued output does not revive the ID
retired by the first join.
Four command cases hold Create root or Split, queue Merge with that input as
the first endpoint, and confirm the input while Merge is still pending. They
check complete topology, provisional status, visible membership, selection,
both final merge directions, and a subsequent queued Move. Two mock-browser
cases use the same sequences to check published render chunks, the Preview
badge, selection, and agreement with the saved graph after reload.
Four command regressions hold Add child, Create root, Delete, or Split while
Undo and Redo are admitted. They check request IDs, saved geometry, activity,
and a subsequent Undo. The creation cases also hold Undo to inspect Redo's
unchanged preview after the first save. Identity tests distinguish confirmed
IDs from later replacements; the singleton runtime regression now admits Undo
before Delete settles and refolds a fresh authoritative read under that preview.
A mock-browser regression checks the rendered root during the held Undo, all
three saved actions, further Undo/Redo, and agreement after reload.
Screenshots and published render-chunk assertions check selected held states;
they do not claim frame-by-frame flicker detection.

Validation on 2026-09-09 reproduced the Merge retirement race against real
CATMAID before the fix: confirmation left the deleted ID's revision unchanged,
and its held response hit the duplicate-node cache guard. A unit variant with the
survivor evicted instead restored the deleted skeleton. Confirmed retirement now
fences both outcomes. The retained Split Undo regression also passes after prior
cache eviction; it awaits actual Split settlement before evicting the snapshot.

Validation on 2026-09-11 after giving Merge previews independent temporary IDs
passed all 660 skeleton unit tests across 44 files, all 31 mock-browser cases,
and all 27 real-CATMAID Docker cases. Review reproductions had shown pending
Create → Merge and Split → Merge snapshots stranded under an input's old ID,
including disappearing render chunks and an empty Skeleton panel.
The subsequent overlapping-history fix passed all 665 skeleton unit tests,
32 mock-browser cases, and 27 real-CATMAID Docker cases. After consolidating the
identical remapping loops and moving candidate cloning into logical mappings,
all 665 unit tests and four focused creation/reversed-Merge browser cases passed
again. The browser creation case also reselects the pending root and verifies
its Preview label. No retries or increased timeouts were used.
The dependent-edit command regressions
reproduced stale Undo payloads before the correction. The chained-Merge cases
also reproduced an incorrect restoration root and a retired output ID. The
mock root-confidence regression failed before its Merge behavior was corrected.
The final browser and Docker runs passed without retries or increased timeouts.
Type checking, affected-file lint/format checks, and 30 local documentation target
checks passed. The RST guide rendered without warnings and its visible text
matched the Markdown guide.

The Docker run covers creation and singleton retirement races, drag cancellation
and remapping, pending Split/Merge dependencies, optimistic navigation/filtering,
property edits, original-root restoration, replacement IDs, Undo/Redo, and reload.
The disposable containers and volumes were removed during teardown.

`npm run test:skeleton:unit` includes skeleton, CATMAID, skeleton UI, segmentation
integration, dependent-view lifecycle, and fixture/helper unit tests. Docker
startup reports the original failure even if collecting logs or removing
containers also fails; both follow-up operations are attempted and their errors
are reported separately.

Useful commands are:

```bash
npm run test:skeleton:unit
npx vitest run \
  src/skeleton/complete_skeleton_snapshot.spec.ts \
  src/skeleton/queue_admission.spec.ts \
  src/skeleton/command_history.spec.ts \
  src/skeleton/optimistic_edit \
  src/datasource/catmaid/spatial_skeleton_edit
npm run typecheck -- --pretty false
npm run lint:check
npx prettier --check \
  src/skeleton/optimistic_edit \
  src/datasource/catmaid/spatial_skeleton_edit \
  src/skeleton/complete_skeleton_snapshot.ts \
  src/skeleton/queue_admission.ts
git diff --check
```

Static acceptance should also prove the absence of physical-resource overlap,
lease expansion, disposal compensation, rejection rebasing, provider cache
access, compatibility aliases, public queue clearing, removed debug APIs, and
optional fallbacks for mandatory queue/projection/history capabilities.

## Maintenance checklist

For every operation family, verify together:

1. Execute, Undo, Redo, and queued-opposite behavior;
2. immediate ordered admission, complete fenced inputs, and queue-owned hydration;
3. logical dependencies and strict per-layer authority order;
4. mutation-scope FIFO and provisional-ID resolution under lease;
5. failure-atomic preview and authoritative adoption;
6. complete suffix rollback with earlier history preserved after definitive failure;
7. fatal classification after any physical commit or ambiguity;
8. asynchronous disposal with zero inverse/compensation requests; and
9. snapshot-depth checkpoints without changes to Undo/Redo results.

Keep generic modules datasource-free. Keep CATMAID endpoint policy and response
interpretation in its adapter/workflow files. Do not reintroduce a feature flag,
dual runtime, provider queue, resource-overlap scheduler, recovery path, or
compatibility mode.

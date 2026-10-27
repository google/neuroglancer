# Spatial skeleton edit queue

This is the maintainer guide for optimistic editing of spatially indexed
skeletons. It describes the datasource-neutral edit queue, complete-skeleton
storage, inspected-input boundary, authority lane, failure policy, and CATMAID
integration.

The edit queue is the only editing architecture for writable spatially indexed
skeleton sources. Queue, history, preview, identity, scheduling, and
Reload-required state are generic. A datasource supplies only the logic needed
to describe and persist its edit plans.

## Glossary

- **Optimistic edit**: an edit shown on screen before the server confirms it,
  and reverted if the server rejects it.
- **Intent**: one user transition: Execute, Undo, or Redo. A compound intent
  can send several server requests.
- **Preview**: the skeletons as they look with every pending edit applied.
- **Authority**: the server's copy, treated as the truth.
- **Edit request**: one write request to the authority. An **edit request
  scope** is the key (for CATMAID, the server and project) whose writes run one
  at a time. An **attempt** is one physical step of an intent's plan.
- **Plan**: the stored, immutable list of server steps for one intent
  (`CatmaidEditPlan` for CATMAID).
- **Planner**: the datasource object that turns an intent into a preview and a
  plan, and reads the results (`SpatialSkeletonEditPlanner`;
  `CatmaidEditPlanner` for CATMAID).
- **Recipe**: the history entry for one undoable transition: its plan, its
  preview and its inverse preview.
- **Pending edit**: an accepted edit whose preview cannot show yet; it shows as
  a marker.
- **Display**: what the layer shows: confirmed skeletons plus every preview.
- **Complete skeleton**: an immutable copy of all nodes of one skeleton
  (`CompleteSkeleton`), not only the chunks in view. A set of them, keyed by
  stable skeleton handle, is a `CompleteSkeletonSet`.
- **Delta**: one requested change to complete skeletons, with its inverse.
- **Stable ID handle**: a handle for a node or skeleton that stays the same
  when the server renumbers it. It maps to a provisional or a confirmed ID.
- **Provisional ID**: a temporary ID for a node or skeleton the server has not
  created yet.
- **Reload required**: a permanent stop state, entered when local state can no
  longer be trusted.

## Where the code lives

Each file's `@file` comment states its job.

`src/skeleton/edit_queue/` holds the generic queue. It must not import
`src/datasource` or `src/skeleton/edit/`; eslint enforces both.

`src/skeleton/edit/` holds the layer-facing side.

`src/skeleton/edit_commands.ts` holds the edit actions and the command contract
that a datasource implements.

`src/datasource/catmaid/spatial_skeleton_edit/` holds the CATMAID planner; see
[CATMAID boundary](#catmaid-boundary).

## Runtime structure

```text
EditableSkeletonSource
  -> editPlannerProvider.createPlanner({ source, identities, provisionalIds })
                       |
                       v
SpatialSkeletonEditSession (one per layer)
  - edit queue and canonical intent journal
  - edit preview and stable ID handles
  - previewed undo history
  - immutable Reload-required latch
                       |
                       v
SpatialSkeletonEditQueue
  validate inspected source -> admit -> acquire inputs -> prepare exact preview
          -> acquire scope lane -> mutate authority
          -> adopt authority -> settle history -> release lane
                       |
                       v
datasource planner and edit request adapter
  - immutable plans
  - under-lease request materialization
  - result interpretation and authoritative reconciliation
```

One logical intent is an Execute, Undo, or Redo transition. A compound intent
may have several physical steps, but it keeps one authority lease for those
steps. Distinct intents release the lease and enter the scope FIFO separately.

Generic edit-queue modules must not import `src/datasource`. Datasource
plans and transport results are opaque at the generic boundary. A
datasource does not own queue status, undo history, dependencies, identities,
preview publication, scheduling, or Reload-required state.

Queue, preview, and history capability methods are mandatory at their generic
ports. Callers do not probe for optional methods or silently substitute
fallback behavior. A missing capability is a construction/type contract error,
not a second runtime mode. Command factories receive only their action payload;
they do not receive the layer. Execution wrappers forward the required
`acceptedByQueue` and `settled` promises rather than infer authority settlement
from the earlier exact-preview promise.

Layer action availability validates the datasource's editing contract and its
planner registration. Command dispatch trusts that contract, checks the current
read-only/Reload-required gates, and resolves the requested factory; it does not repeat
the full source-shape check. Planner installation still validates a new
registration before replacing an existing queue.

Public commands and tools use `SpatialSkeletonEditExecution<T>`
directly: ordinary edits use `T = void`, while Undo/Redo use `boolean`.
`withPendingMessage` decorates an execution for Add/Delete/Split/Merge. Its
message ends when the preview promise completes. `edit/submit_edits.ts` attaches
`acceptedByQueue` and `settled`, including to the replacement preview promise
that `finally()` produces. The queue admission boundary observes independent
acceptance rejections. The message wrapper does not add a duplicate handler.

`prepareAndSubmitSpatialSkeletonEdit` submits a reusable input policy
immediately. The queue checks capacity and synchronously validates/pins required
inspected inputs, then registers the journal record, history transition,
sequence, and Preparing state before starting any read. `describeIntent`
supplies the label and optional preparation cue without reading topology.

At the ordered preparation frontier, the policy resolves current logical IDs and
node ownership, then acquires fresh complete skeletons.
`prepareQueueInputBindings` pins cached inputs, loads missing permitted inputs,
and validates endpoints, cache revisions, and the Reload-required gate after every read.
`createQueueInput` deduplicates the resulting snapshot bundle. The planner
compiles its exact preview and plan exclusively from that bundle.
Required-source validation is an admission gate; it does not freeze the old
source version for a later queued action.

An input reference keeps its current snapshot available against inactive-cache
eviction, without locking it or copying it for each consumer. Replacement or
invalidation makes the reference stale. `releaseInputReferences` removes this
preparation step's cache-retention registrations after preview completion or
failure. Other consumers keep their own references; unused data becomes eligible
for cache eviction. Missing-input reads have independent request owners, share an
existing fetch when possible, and survive inactivity while awaited.

The session's `CompleteSkeletonCache` stores this data in browser memory.
`fullSegmentNodeCache` maps segment IDs to complete node arrays.
`fullSegmentSnapshotHandles` maps the same IDs to immutable snapshot handles and
local cache revisions. For example, skeleton 23 can have nodes 1 and 2 in the
array and snapshot H10 at revision 10. After a Move, the current array contains
node 2's new position and the snapshot entry contains H11 at a newer revision. A
consumer holding H10 still sees the old position. Handles and arrays can share
node objects; these are not necessarily two full copies of the data.
`queueInputReferenceRegistrations` records which current snapshots preparation
steps are keeping available. Releasing a reference removes its registration, not
the skeleton data itself.

H10 and H11 here are example labels for `CompleteSkeleton`
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

## Complete skeleton, delta, and history

Keep these three concepts separate:

```text
Complete skeleton = the complete skeleton state at one point
Delta             = one requested transformation of that state
History           = ordered forward/inverse recipes for Undo and Redo
```

A complete skeleton is stable immutable input. It provides the topology and
attributes needed to:

- calculate a complete exact preview immediately;
- derive the exact inverse of an edit;
- partition or combine topology for Split and Merge;
- prepare a later edit over an earlier unconfirmed preview;
- atomically roll back or refold previewed state.

A delta is not a replacement for that input. For example, `split at B` cannot
derive the two resulting components unless it can inspect all of `A -> B -> C`.
Conversely, history does not need to retain every internal node-view link. It
retains an independent forward/inverse recipe for each undoable transition.

### Bounded node-view depth

Complete skeleton handles may use lazy node views internally:

```text
S0 = inspected base snapshot
S1 = Patch(S0, edit 1)
S2 = Patch(S1, edit 2)
...
```

Without a bound, a long editing session leaves the newest snapshot traversing
every predecessor even after older history entries have expired. History
capacity does not break these internal references.

Every complete skeleton therefore has a private node-view depth:

- a base or indexed flat node view has depth 0;
- patch, split view, and remap add 1 to their source depth; and
- merge has 1 plus the maximum component depth; its optional node-override
  patch wrapper adds one more level.

The private rebase threshold is 64. It is deliberately independent of queue
capacity, Undo/Redo history capacity, Recent activity, and the 24-segment
retained-overlay limit.

When a node view at depth 64 or greater is materialized, the handle:

1. materializes its complete frozen node array;
2. builds a node-ID index over that same array;
3. replaces only its private node view with an indexed flat node view; and
4. resets its private depth to 0.

Flattening preserves the public handle, kind, contents, node objects, and any
previously returned materialized array. First materialization builds one array;
rebasing reuses it and does not build another. The handle remains publicly
value-immutable even though its private storage changes.

Before deriving patch, split, merge, or remap state from a source already at or
above the threshold, materialize that source so the new child starts from the
flat checkpoint. An existing child created earlier remains correct because it
kept the immutable node view it was given. Future children use the checkpoint.

The threshold is not a strict maximum depth of 64. For example, merging a
depth-63 input with node overrides can produce depth 65: the merge and override
each add a level. That handle flattens when materialized or before another
operation derives from it. Rebasing does not contact CATMAID, alter the
skeleton, or clear history. Older snapshots may remain retained by other owners,
including history.

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
but topology, attributes, logical identities, and authoritative mappings must be
equivalent.

If edit 63 has expired from bounded history, it cannot be undone regardless of
snapshot rebasing. There is no selective Undo that skips edit 64.

## Generic inspected-input boundary

Commands declare two input groups: `required` must already have a complete
inspected snapshot at admission, while `loadable` may be fetched inside the
queue's Preparing phase. A node visible only through a spatial-index chunk is
insufficient for a required input. Every listed input is needed.

All public Execute actions use this policy. Capacity, inspection validation,
sequence allocation, journal registration, and previewed history happen before
asynchronous input loading. `acceptedByQueue` therefore resolves without waiting
for topology reads; the execution promise still waits for the exact preview.

An action with deferred inputs conservatively depends on all earlier active
layer intents. Preparation waits for their exact previews, then captures the
current previewed snapshots and owning skeletons. Later actions cannot overtake
a loading action, even when their own inputs are cached. This barrier orders
preparation within a layer; it does not change the shared project edit request lane
or serialize preparation across layers. Warm previews still run on microtasks
without waiting for earlier server responses.

The generic preparation policy pins cached inputs, loads missing inputs
sequentially, and rechecks references, endpoint declarations, and the Reload-required gate
after each read. Repeated endpoints in a loaded skeleton reuse its cache. The
bundle follows `required` then `loadable` order and deduplicates skeletons.
Cancellation releases the intent's read owners and references; shared consumers
keep their own ownership. Late canceled read results cannot revive the intent.
An unexpected revision or endpoint change fails preparation. If an earlier
queued save publishes its authoritative correction during loading, the queue
reacquires inputs from that corrected state before compiling the preview.

Undo and Redo normally use retained history recipes without fetching topology.
Undo can also cancel an admitted action before it has a recipe or inverse, with
no edit request. Redo of that unprepared action reacquires complete inputs
through the original policy, including a previously inspected source evicted
while the action was canceled. Its first exact publication retains the recipe
for subsequent Undo/Redo. Input failure rolls back the failed transition and
cancels the later queue suffix under the existing failure policy.

The TypeScript command descriptor is trusted. There is no runtime assertion
rejecting old callback names or validating its action/label/payload shape.
Actual snapshot, endpoint, cache-revision, and Reload-required-state checks remain, as do
datasource payload validation and copying/freezing.

The queue passes Execute planners one datasource-neutral bundle:

```ts
interface SpatialSkeletonQueueSegmentInput {
  readonly segmentId: bigint;
  readonly snapshot: CompleteSkeleton;
  readonly cacheRevision: number;
}

interface SpatialSkeletonQueueInput {
  readonly segments: readonly SpatialSkeletonQueueSegmentInput[];
}
```

The outer object, segment array, and segment records are frozen. Snapshot
handles are not recursively frozen because they maintain private materialized
state. Records are deduplicated in queue-input requirement order. Repeated
requirements for one segment must resolve to the same handle and cache revision;
conflicting duplicates are a contract failure. Root creation receives an
explicit frozen empty bundle.

Input references remain held until the exact-preview promise resolves or
rejects, then release before authority settlement. Preview preparation must use
only the retained bundle. Hydration is owned by the generic queue input policy;
there is no direct edit-session or cache lookup in a datasource planner.

CATMAID declares only the destination of a newly requested Merge as `loadable`.
The source must already be inspected. The destination uses a shared fetch with a
120-second deadline. While it loads, the intent is visible as Preparing, its
history transition is available to Undo, and the coarse merge preparation cue is
shown. A complete exact preview and edit request wait for validated inputs. Failed
or timed-out reads are cleared so a later user action can try again.

While an edit or the merge-target prefetch awaits a full-skeleton read, that
read starts before display reads waiting in the concurrency limiter, including a
display read it joined while queued. Once nothing awaits it, it waits its turn
again. While a merge anchor is set, the edit tool also prefetches the skeleton
under the pointer (`edit/merge_target_prefetch.ts`) and protects the loaded
snapshot from eviction until the target changes, so the second pick usually
admits synchronously.

Root creation has no existing input. Restoration of a deleted one-node skeleton
is root-like. Other CATMAID Execute actions use only `required` inputs.

## Edit tool and selection details

A drag captures the selected node's logical handle at mousedown. Each pointer
move resolves its current node ID, and mouseup uses its current cached node and
owning skeleton when constructing the Move command. An earlier creation, Split,
or Merge may be acknowledged during the gesture; the captured physical IDs and
node snapshot must not be reused for submission. This also covers
acknowledgement before the drag threshold or after the last pointer movement.

Radius, Description, and Confidence keep their focused controls and view
contexts intact. While the same logical node and editing runtime remain active,
selection-details views (including ancestor views) defer rebuilds until user
blur. This preserves native text Undo/Redo, textarea selection, the Radius
spinner's pending 500 ms save, and keyboard focus in the Confidence dropdown.
Copying the text or moving the textarea to a replacement view would lose native
Undo history.

The rest of the application continues to publish previews and acknowledgements;
the selection-details view catches up with the latest model on blur. Property
commits and node actions resolve the logical node to its current cached node, so
permanent-ID assignment cannot redirect an edit to the old provisional ID.
Description, Radius, Confidence, and True End also use that current node for
unchanged-value checks. Switching between protected editors can preserve the
same view across several edits or a rejected preview; render-time values and
last submitted values are not reliable comparisons. Restoring the original
Description must save, and retrying a rejected Radius must compare against the
rolled-back value. Returning Confidence or True End to the value already
restored by rollback creates no action and preserves any valid Redo branch. A
different selection or source, deletion, or Reload required invalidates the
focus guard and allows the view to rebuild. Closing the view disposes its
listeners and pending saves normally. Unregistered controls keep the existing
redraw behavior.

The Skeleton tab's Undo/Redo buttons use the same queue eligibility queries as
action dispatch, with undo history supplying the labels. Reload required keeps
both buttons disabled and supplies their explanatory tooltip.

Edit-session Undo/Redo dispatch checks eligibility before calling the queue. An
unavailable transition creates no queue entry, history ticket, or server
request, including when reached through a shortcut or direct API call. The
edit session returns its existing completed `false`/unchanged-no-op execution;
public command wrappers do not construct a second fallback result.

When a primary pointer press starts inside the protected skeleton details
container, or a view containing a protected focused editor, that view and its
ancestors also defer rebuilding through pointer release. The container guard is
registered once and shares the property editors' selection/source validity
check. This is captured before blur: saving a draft on blur can dirty a
previously clean view. Rebuilding on the next frame while the mouse is still
down would remove the pressed button and lose its click. After pointerup the
next animation frame applies the latest model, allowing the intervening click to
finish normally. Pointer cancellation, window blur, view disposal, or
invalidating the editor also release the press. The guard applies only to
opted-in views, with no fixed click delay or synthetic click dispatch.

A drag also captures its interaction generation. Deactivating the edit tool
invalidates its pointer-move and mouseup callbacks, clears the gesture preview,
and releases its temporary browse exclusion and cursor. Reactivating the tool
does not revive the abandoned drag; only a new gesture may submit a Move.

Preparation cues (`edit/pending_edit_markers.ts`) describe local preview
computation. They do not carry a wait reason for topology fetches or server
acknowledgements: required inputs are already inspected, and previews can use
provisional identities. The Details status matches either the selected physical
ID or its logical identity across remapping, without displaying temporary IDs.

## Execution boundary

The execution boundary has dedicated operations:

- `submitExecute(command, queueInput)`;
- `submitUndo()`; and
- `submitRedo()`.

Execute planner creation receives `{ intentId, intent: "execute", queueInput }`.
Undo/Redo creation receives `{ intentId, intent, recipe }`, where the generic
queue has already selected one exact `{ plan, preview, inversePreview }`
history recipe. Datasources receive no history ticket or history lookup
callback.

## Admission and preview publication

The high-level order is:

1. Check Reload-required state, capacity, and required-source inspection; pin cached sources.
2. Reserve an intent ID and stage the previewed history transition.
3. Register the description, input policy, conservative resources/dependencies,
   and any truthful preparation cue in the canonical journal.
4. Resolve `.acceptedByQueue`.
5. Wait for preceding exact previews, acquire current complete inputs, and compile
   the plan, fixed logical identities, and preview recipe.
6. Reduce and atomically adopt the exact preview.
7. Resolve the exact-preview execution promise and release input references.
8. Wait for the intent's layer order and acquire its edit request-scope lease.
9. Execute and reconcile the datasource plan.
10. Adopt the authoritative result, settle history, release the lease, and
    resolve `.settled`.

Public Execute actions use a conservative layer preparation barrier while their
resources are unknown. They wait for earlier exact previews, then use current
previewed inputs, without waiting for server replies. Retained history recipes
can prepare independently once their dependencies have exact previews. Physical
transport still follows strict intent order within each layer.

Every local publication follows one failure-atomic strategy: build the complete
candidate off-screen; check the action's local preconditions, cache revisions,
and identity bindings; prepare an immutable publication; adopt it synchronously
by reference; then emit one presentation revision. The edit session materializes
changed snapshots once to build rendering and reverse-index data, but production
does not rescan the complete tree to validate reducer output. Adoption does not
invoke datasource callbacks or perform transformations that can throw. UI hints
such as selection, navigation, pinning, and long-lived visibility run afterward
as isolated best-effort effects.

## One FIFO authority lane per edit request scope

`editRequestAdapter.editRequestScope` is the only physical scheduling key. Each scope
has one global FIFO lane, so layer-owned queues targeting the same authority
cannot race. There are no physical node/segment/source resource descriptors,
resource-overlap calculations, resource expansion, or CATMAID-specific serial
scheduler.

Within a layer, authority starts in intent-sequence order and at most one
plan runs at a time. Across layers, lease acquisition order is the scope
FIFO order. Preparation and exact preview are independent of that lane.

A compound plan reuses its lease across all steps. A distinct intent,
including Undo or Redo, releases and reacquires so it cannot bypass older
cross-layer waiters.

Lease states are:

- `active`: the queue owns the scope lane;
- `retained`: Reload required permanently fences that scope for the page; and
- `released`: the next FIFO waiter may acquire the lane.

Once a scheduler transfers the lease to the queue, every scheduler outcome
returns it to the queue. Only the queue decides whether to release or retain it
after preview, journal, history, and UI state agree.

CATMAID interns `editRequestScope` from normalized base URL and project ID. Thus
only one CATMAID edit request for a project runs at a time across layers. A second
layer can still prepare and display an exact preview while it waits. Other
edit request scopes remain independent.

## Definitive failure and history rollback

When no physical step has committed and the outcome proves the server unchanged:

1. Cancel the failed intent and every later nonterminal intent before transport.
2. Atomically remove their exact previews and replay earlier active previews.
3. Reject the journal suffix and call `history.rollbackFrom(failedTicket)`.
4. Synchronize retained-history ownership before settling the failed root with
   its real reason and later intents as `unchanged/not-started` with:

   ```text
   Canceled because an earlier edit was not saved.
   ```

5. Release the authority lease after preview, journal, history, and UI agree.

`rollbackFrom` removes the failed transition and all later staged transitions,
including out-of-order confirmations from locally canceled edit/Undo pairs. It
rebuilds previewed Undo/Redo from the confirmed stacks and surviving earlier
transitions. Earlier in-flight tickets can still confirm normally. Later local
cancellation pairs keep their Reverted activity rows, but cannot reintroduce
history discarded by the failure.

A failed Execute restores the earlier Redo branch it cleared and any history
entries it displaced through capacity trimming. Failed Undo/Redo restores the
original edit to its source stack, where an explicit retry is available. A
failed original Execute never becomes a Redo retry. All later unfinished edits
are canceled, including edits to unrelated skeletons in the same layer.

Canonical recipes referenced by staged transitions must remain retained even
when absent from the confirmed/previewed stacks and Recent activity. An earlier
in-flight save can leave a locally canceled pair staged while a newer Execute
hides its Redo entry. If that Execute fails, the pair's original recipe is
needed again. These temporary recovery references are released as transitions
confirm or are discarded; they do not enlarge the user-visible history capacity.

Missing rollback boundaries or failures restoring the local preview/history
require reload and reset the complete history. Since authority is unchanged, the
affected lease is released. Unknown outcomes and partial commits retain their
existing Reload-required reset and lane-fencing behavior.

A failure before canonical admission abandons only the newly staged history
transition and creates no Queue row or preview. History exposes only the
operations needed by this model: `abandonLatest(ticket)`, `rollbackFrom(ticket)`,
`confirm(ticket)`, and `reset()`. Confirming a discarded ticket is a no-op.

There is no dependency rebase, failed-Execute Redo retry, or mutable replacement
of dependencies. If any physical step has committed, a later failure cannot be
treated as a definitive unchanged outcome; it enters Reload required. Every step
must succeed before its exact preview can be confirmed. In particular, a failed
reroot after merge split-back requires reload because the server has different
or unknown topology.

## Reload required

Finite authority outcomes are committed, rejected, not-started, and
indeterminate.

- Rejected/not-started before any commit uses the definitive suffix rollback and
  history-rollback policy above.
- An indeterminate started transport may have changed authority. The queue
  latches `authority-indeterminate`, retains the scope lease, and leaves
  `.settled` pending until reload.
- A known commit that cannot be published locally latches
  `committed-local-publication-failed`, retains the lease, and leaves `.settled`
  pending.
- A later step that fails after an earlier compound step committed is also a
  committed local-publication failure, not a rejection.
- If a definitive local rollback/refold cannot be published, the queue latches
  `local-preview-reset-failed`. Authority is known unchanged, so it releases
  rather than retains the scope lane, but the layer still requires a reload
  because its visible preview cannot be trusted.

The first Reload-required reason wins. Reload-required entry stops the pump, cancels every
pre-commit submission, removes its cue and preview in one refold, blocks new
Execute/Undo/Redo, retains an authority-unsafe faulting lease, and publishes one
persistent Reload-required notification. A local preview-reset fault releases
its definitively unchanged lane. Started transport is classified but not
aborted. No later plan step starts after Reload-required entry.

Queue and Recent activity messages preserve each intent's recorded cancellation
reason. Unsent work canceled by a Reload-required state says "Canceled because another
edit requires a page reload." It does not imply that the faulting edit was
definitively rejected; that edit may have committed or have an unknown outcome.

There is no automatic recovery, edit request retry, topology-verification GET, or
scoped refresh. The Queue UI exposes one persistent `role="alert"` banner and
**Reload page** action. Inspection, selection, filtering, pinning, and
navigation remain available, but editing does not.

## Disposal

The queue's `dispose(): Promise<void>` is idempotent. Disposal stops pumping,
cancels pre-commit submissions, removes preparation cues, atomically refolds
away unresolved previews, resets staged history, and settles unsent intents as
`unchanged/not-started`.

Disposal never sends an inverse edit request and has no compensation phase:

- a started transport that is definitively rejected settles unchanged and
  releases the lane;
- a committed result, or a plan with any earlier committed step, latches
  `committed-local-publication-failed` and retains the lane; and
- an indeterminate result latches `authority-indeterminate` and retains the
  lane.

Datasource cleanup waits for classification and planner unwinding, but not for
the deliberately pending Reload-required `.settled` promise. A replacement queue
may prepare previews immediately. Its transport waits behind a retained old lane
when reload is required.

There are no compensation-only plan phases, `compensated` settlement,
`Reverting` state, or CATMAID reversal on disposal. Ordinary explicit Undo/Redo
remains supported. A queued-opposite no-op may still be reported as a local
**Reverted** activity; it did not send compensation.

## Identity resolution during overlapping Undo/Redo

A stable ID handle can have a confirmed ID and several intent-owned provisional
replacements. They serve different moments in the queue:

- Baseline snapshots and ordinary authoritative reads use confirmed IDs.
- `mappings.clone(throughSequence)` creates an isolated candidate; zero excludes
  every provisional overlay. Identity-copy logic stays with mapping storage.
  Owner and overlay-token lookups read the mappings directly, without creating a
  candidate or copying every node binding.
- Preview replay starts from those IDs and stages each intent's provisional
  bindings immediately before reducing that intent. Future replacements are not
  visible to earlier deltas.
- Promotion uses the committed intent's mappings, excluding later overlays.
  Returned IDs remap that promoted snapshot; pending previews are then replayed.
- Request materialization uses `resolveAuthoritativeNode/Segment`, with results
  from earlier steps in the same compound plan taking precedence. A preview
  alone never supplies a transport ID.
- Display remaps follow the final preview. An earlier response must not replace
  a later Redo's temporary node or skeleton ID. Active previews also own absence:
  a hidden confirmed snapshot must not reappear beside its replacement.

For Add → Undo → Redo with Add still saving, each action reuses the created
node's stable ID handle. Add's response supplies the real ID for Undo's delete
request. Redo keeps its own temporary ID on screen until its creation succeeds.
The same ordering applies to Delete's restoration and Split/Merge history. This
uses the existing confirmed mapping and provisional overlays, without a second
persistent identity store or extra server reads.

`stable_id_handles.ts` defines stable handles and their provisional/authoritative
ID mappings independently of queue records. The edit preview owns the mapping
instance; the journal imports only handles and resource-key helpers.

## No settlement-time verification

A validated edit request response plus retained complete queue input is the
authority proof. Reconciliation applies returned node/segment bindings,
retirements, and any preview correction, then adopts once. It does not call
`fetchCompleteSkeleton()` to verify topology.

There is no topology-refresh batch, expected-presence registry, verification
generation, retry/backoff timer, or background healing. Split/Merge topology
comes from complete skeletons and returned IDs. Reroot uses the locally derived
topology. CATMAID edition timestamps are not retained in nodes, chunks,
snapshots, or reconciliation. Local cache revisions still reject stale reads,
including reads that arrive after confirmed retirement. Merge explicitly retires
CATMAID's deleted physical skeleton ID while retaining the logical aliases used
by Undo. Retirement advances that ID's cache revision even when the preview has
already removed its snapshot, and cancels retained reads. The revision check
also rejects responses from sources that ignore cancellation. A pending Undo can
keep its provisional replacement without reviving the retired physical ID.

Preview adoption does not invalidate spatial-index cells because the datasource
grid may still return stale data. The presentation records explicit segment
removals separately from cache eviction. Rendering discards removed segments'
GPU chunks, skips their complete reads, and suppresses their grid copies even
after they leave the retained overlay pool. A replacement snapshot clears its
removal; source/runtime reset clears all removals. Pending Undo can therefore
render a replacement ID while the deleted physical ID stays hidden. Ordinary
cache eviction still preserves the last rendered chunk during reload.

GPU geometry reuse compares immutable node-array identity and the drag-position
key. Snapshot handles have no revision or version counters; their immutable
identity and contents are sufficient. Edit-session cache revisions and logical
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
confidence write when the original root had a different value. All inverse steps
share the plan lease and must finish before Saved. A Merge attachment that
is already a root keeps its existing confidence.

CATMAID can reverse a Merge's direction. During authoritative publication, the
edit preview refolds active previews in order and lets the queue rebuild queued
Undo/Redo recipes from the finalized action and earlier refolded artifacts.
Their preview, provisional bindings, and plan are updated together; failed
preparation does not publish the candidate. CATMAID history takes Reroot's and
Merge's original root and confidence, Split's former parent, Delete's restored
connections and node values, and Confidence's previous value from the canonical
inverse. Undo therefore saves the same topology and properties that it previews
after an earlier Merge changes direction, including repeated Undo/Redo with
replacement node and skeleton IDs.

For example, merge A with B, then queue a Merge of that combined tree under C.
If CATMAID reverses the first Merge, Undo of the second must restore the
corrected root of A+B, including its confidence. The Merge recipe retains one
restoration root from the canonical inverse instead of choosing between roots
captured at admission. A forward Merge gives its distinct output handle an
intent-owned provisional numeric ID, just like Split. It never borrows an
input's ID: a pending Create, Split, or earlier Merge can receive a different
saved ID without moving the merged snapshot away from its visible overlay. The
ordinary mapping overlay commits the output to CATMAID's surviving ID when Merge
saves, or is discarded on rollback. Until then the merged skeleton is shown as
**Preview**.

If the reply arrives during Undo/Redo preparation, the queue discards the
outdated candidate and prepares the current history recipe before publication.
Presentation remaps follow the final preview's logical owners. Each numeric
remap is applied once, so exchanging which skeleton owns a provisional ID does
not collapse both restored overlays onto the merge survivor.

Known limits: stable-ID-map garbage collection and a bound on the
notification-deduplication set are not implemented.

## Add an editable datasource

A source becomes editable when its `MultiscaleSpatiallyIndexedSkeletonSource`
subclass returns an `EditableSkeletonSource` from `editableSource`. That object
supplies:

1. `edgeDirection`, `getSkeletonManifest` and `getSkeletonFragment`, which
   read complete skeletons;
2. a command factory for each action. Add, Move, Delete, Split and Merge are
   required. Insert, Reroot, and the four node-attribute commands are optional;
3. `editPlannerProvider.createPlanner`, which returns a planner, an edit
   request adapter, an optional provisional-ID policy, and an optional
   `cleanup`; and
4. `confidenceValues`, only if the server stores a fixed set of confidence
   values.

The CATMAID files hold two kinds of code. A new datasource can copy this code,
which has no CATMAID logic:

- the payload checks in `command_payloads.ts`;
- the queue-input requirements in `command_factories.ts`; and
- the deltas, previews and UI hints in `CatmaidEditPlanner`
  (`edit_planner.ts`).

A new datasource must write its own version of the CATMAID-specific code:

- the semantic types and the immutable plan and inverse recipe, with split,
  merge, reroot, and compound steps, in `edit_plan.ts`. The captures in
  `CatmaidEditPlanner` fill these types, so adapt them rather than copy them;
- authoritative ID resolution immediately before transport, the scalar
  request payloads, response validation, and authoritative identity mapping,
  in `CatmaidEditPlanCommitBase` (`edit_planner.ts`);
- the edit request scope and finite failure classification, in
  `edit_requests.ts`; and
- the transport: `api.ts`, with its `nocheck` state policy, and the `commit*`
  methods of `CatmaidSpatialSkeletonEditCommands` (`command_factories.ts`).

`edit_planner.ts` also holds CATMAID rules: the defaults for a new node, the
provisional-ID range, the authority labels and messages, and the blocks on a
delete of a root with children and on a true end at a root or any non-leaf
node. Both `edit_planner.ts` and `command_factories.ts` cut positions to rank-3
model space. Replace these rules in a copy.

CATMAID is the first editable skeletons source, so it is possible that some
pieces of generic code and architecture are within the CATMAID datasource. If
adding an additional datasource, a reasonable step would be to attempt to
pull out pieces of this generic code.

## CATMAID boundary

CATMAID builds Execute plans exclusively from `queueInput`. Its planner does
not retain a layer reference and does not read edit-session or cache state.
Provider context retains `source`, logical identities, and provisional-ID
allocation, but not `layer`.

The generic queue admission boundary still supplies complete immutable
snapshots. Each datasource chooses which logical node identities and authority
data its opaque plan retains. CATMAID binds only the nodes needed by the
action and materializes scalar endpoint arguments under the authority lease;
another datasource may deliberately bind or materialize a complete graph.

[Add an editable datasource](#add-an-editable-datasource) lists the
CATMAID-specific responsibilities and their files.

For Insert, CATMAID captures the parent and children from the admitted snapshot
and uses its existing created-node plan, with an insert transport step and the
compact `restore-delete` preview. Undo deletes the inserted node and reconnects
its children; Redo inserts it again using the current authoritative identities.
No separate preview operation is needed.

CATMAID does not implement a queue, history registry, physical-resource list,
lease cursor, compensation plan, direct cache lookup, or Reload-required
policy.

## Subscriptions

Queue subscriptions use Neuroglancer's `NullarySignal`. An observer error is
reported and does not fail an already-adopted edit. As with any `Signal`, it
still stops the observers after it. The queue keeps its `subscribe()` interface
and asynchronous disposal.

## Testing

At minimum, cover:

- thousands of lazy patch levels without recursive failure;
- flat checkpoints at 64, 128, and 192 with stable handle, node-array, and
  unchanged-node identity;
- sequential Undo 64 then Undo 63, followed by Redo 63 and Redo 64;
- rebase-boundary move, attribute, split, merge, and authoritative remap;
- frozen/deduplicated inspected bundles, empty root input, input retention
  lifetime, cold Merge loading, conflict rejection, and no CATMAID cache lookup;
- same-scope FIFO, different-scope concurrency, per-layer intent order,
  compound lease reuse, and reacquisition between intents;
- definitive failure suffix cancellation and preservation of earlier history;
- disposal before transport, late rejection, late commit, ambiguity, and
  partial compound plans with zero compensation POSTs; and
- Reload-required lease retention and replacement-queue behavior.

The Docker suite (`tests/skeleton_edit/*.e2e.ts`) keeps the following regression
checks, named by test title:

- **"move: the edit shows at once, Undo and Redo work, and it stays after
  reload"** (`node_editing.e2e.ts`): turning editing off during a drag discards the preview and sends no
  edit request, even if editing is reactivated before mouseup. Later pointer
  movement cannot revive that preview or add queue/history entries. A new
  gesture still saves normally, with Undo/Redo and reload checks. The same case
  holds a Move while typing a description. Its acknowledgement must preserve the
  focused control and native text Undo/Redo, without changing skeleton history
  or sending a description edit request. Typing continues, and only the subsequent
  blur saves the completed description; Undo restores its original value before
  the Move Undo/Redo and reload checks. Another held Move preserves a Radius
  draft without sending a radius edit request; blur without further typing then
  saves it exactly once, and Undo restores both the previous radius and
  coordinates. A spinner change during another held Move also survives
  acknowledgement: its existing debounce sends exactly one Radius edit request
  without a user blur. A before-request gate verifies preview/backend
  separation, followed by save and Undo of both changes.
- **"description: …"** (`node_editing.e2e.ts`): empty, whitespace-only, and reserved-label descriptions agree with
  CATMAID after save and canonical Undo/Redo.
- **"children and a move added while a new root is saving use CATMAID's IDs,
  through full Undo and Redo"** (`node_editing.e2e.ts`): newly created nodes retain explicit property defaults through full
  Undo/Redo. Reroot and non-root Merge also restore their original root's 0%
  confidence through repeated Undo/Redo, held confidence writes, replacement
  skeleton IDs, and reload. Real graph comparisons do not substitute missing
  radius or confidence values. A separate step holds the real creation response,
  starts dragging its provisional root, and releases the acknowledgement before
  mouseup. The continued drag and Move request must use the permanent node ID. A
  new root's held creation response also checks a Description draft across
  permanent-ID assignment: the same control, text, focus, caret, and native text
  Undo/Redo survive, with no description request on acknowledgement. A 150 ms
  press on Delete saves the draft on blur, survives the deferred redraw, and
  targets the permanent ID from the retained view. Undo recreates the root with
  a replacement ID and its description; further Undo/Redo checks both edits
  across replacements before reload. A held Move checks preview/backend
  separation; Undo/Redo checks the original coordinates, recreation with
  another node ID, and the final coordinates on reload.
- **"Undo of deleting a singleton restores it with its properties under a new
  ID"** (`node_editing.e2e.ts`): a restored singleton has a real rendered chunk before Redo; that chunk
  disappears during the held deletion and remains absent after Saved.
- **"Split a chain: …" and "Split a branch: …"** (`structural_editing.e2e.ts`):
  each Split Undo holds the Merge request, captures a real read of
  the downstream skeleton before CATMAID deletes it, and holds that response
  across confirmation. The deleted ID's revision advances, its retained read is
  canceled, and the restored topology remains correct after releasing the stale
  response. Both cycles still verify replacement IDs, Redo, and reload.
- **"Merge at the target root separates again without reroot"**
  (`structural_editing.e2e.ts`): merging at an existing root preserves its non-default confidence
  without an extra reroot. A real target-skeleton response captured during the
  pending Merge is held across confirmation and cannot restore the deleted ID.
- **"non-root Merge preserves branches and restores both original roots
  repeatedly"** (`structural_editing.e2e.ts`): repeated non-root Merge Undo restores both original roots, including
  non-default root confidence. Separate gates hold split, reroot, and confidence
  restoration while the complete inverse is already visible.
- **"reroot reverses the attachment path and carries edge confidence"**
  (`structural_editing.e2e.ts`): standalone reroot Undo restores non-default root confidence and stays
  Saving until that confidence write completes.

Useful commands:

```bash
npx vitest --run --project node src/skeleton src/datasource/catmaid
npx tsgo --noEmit
npx eslint src/skeleton src/datasource/catmaid
```

Static acceptance should also prove the absence of physical-resource overlap,
lease expansion, disposal compensation, rejection rebasing, provider cache
access, compatibility aliases, public queue clearing, removed debug APIs, and
optional fallbacks for mandatory queue/preview/history capabilities.

## Maintenance checklist

For every operation family, verify together:

1. Execute, Undo, Redo, and queued-opposite behavior;
2. immediate ordered admission, complete fenced inputs, and queue-owned hydration;
3. logical dependencies and strict per-layer authority order;
4. edit request-scope FIFO and provisional-ID resolution under lease;
5. failure-atomic preview and authoritative adoption;
6. complete suffix rollback with earlier history preserved after definitive failure;
7. Reload-required classification after any physical commit or ambiguity;
8. asynchronous disposal with zero inverse/compensation requests; and
9. node-view depth checkpoints without changes to Undo/Redo results.

Keep generic modules datasource-free. Keep CATMAID endpoint policy and response
interpretation in its `spatial_skeleton_edit/` and `api.ts` files. Do not
reintroduce a feature flag, dual runtime, provider queue, resource-overlap
scheduler, recovery path, or compatibility mode.

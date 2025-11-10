### What “SharedObject”, the decorators, and the RPC are (in plain words)

Here’s the mental model Neuroglancer uses to let the main thread (frontend) and the worker (backend) coordinate:

- RPC is the postal system. You “register” named message handlers on both sides and you “invoke” those names with payloads. Some RPC calls return values via a promise protocol with cancellation and progress.
- SharedObject is a cross-thread object handle with reference counting. A class instance owned on one side has a corresponding lightweight counterpart on the other side. They stay in sync by sending RPC messages. When both sides drop references, the pair auto-disposes correctly.
- Decorators are just a convenient way to register classes with the RPC factory so the other side can construct the right counterpart class by name.

Once you keep those three ideas in mind, the rest of the patterns (like sharing a watchable value or a visibility priority) are applications of the same basic mechanism.

---

### RPC in this codebase

Core file: src/worker_rpc.ts

- Message router
  - registerRPC(name, handler) records a function capable of handling messages named “name”.
  - rpc.invoke(name, payload, transfers?) serializes your payload and posts it to the other side. The other side looks up handler by name and calls it.

- Promise RPC (request/response)
  - registerPromiseRPC(name, handlerWithProgress) wraps a handler so responses go back via a standard reply channel and the caller gets a Promise.
  - rpc.promiseInvoke(name, payload, { signal, progressListener, transfers }) sends the request and returns a Promise. If you pass an AbortSignal, the other side will receive a cancellation via the standard PROMISE_CANCEL_ID. If you pass a progressListener, the other side can emit progress spans back.

Key snippets (file: src/worker_rpc.ts):
- Registry and invoke: handlers map, registerRPC, RPC.invoke (lines ~42–46, 225–236).
- Promise protocol: registerPromiseRPC and rpc.promiseInvoke with cancel and progress (lines ~74–108, 238–269, 110–145, 130–140).
- Ready/queue: when the peer worker isn’t ready yet, outgoing messages get queued until onPeerReady flushes them (lines ~158–189).

Why this matters: It turns postMessage into a tiny RPC framework with named calls, requests that can be cancelled, and streamable progress events.

---

### SharedObject: a cross-thread, ref-counted object pair

Core file: src/worker_rpc.ts

- A SharedObject is a RefCounted instance that exists on both sides (owner and counterpart). The owner creates the counterpart using a factory call; the counterpart is a lightweight representation used to send signals back to the owner. Both halves refer to each other via an RPC id.

- Ownership and lifecycle
  - Owner side calls initializeCounterpart(rpc, options). That:
    1) sets up bookkeeping (rpc, rpcId),
    2) marks itself as owner,
    3) invokes SharedObject.new with type and options so the other side constructs the counterpart (lines ~290–298).
  - Counterpart creation (other side): SharedObject.new handler looks up the registered constructor by the type string and new()’s it (lines ~439–446). Counterpart starts with refCount zero.
  - Reference model: addCounterpartRef() returns { id, gen }, where gen is a monotonically increasing generation number that tracks references flowing to the other side (line ~307–309). When a counterpart’s refcount drops to zero, it notifies the owner via SharedObject.refCountReachedZero (lines ~398–402), passing back the generation that reached zero.
  - Cleanup:
    - If the owner’s own refCount hits zero and the most recent generation has been released by the counterpart (generations match), ownerDispose() runs and tells the counterpart to dispose (lines ~311–337).
    - The SharedObject.dispose RPC validates refCount is zero, deletes the mapping, and nulls fields (lines ~382–396).

- Key fields
  - rpc, rpcId: the communication endpoint and the numeric id that identifies this object across the channel.
  - isOwner: true on the side that initiated the counterpart creation; false on the counterpart; undefined before init.
  - referencedGeneration, unreferencedGeneration: let the owner track which counterpart reference generation has hit zero. This avoids races if multiple references are sent over time.

Plain-English analogy: imagine the frontend owns a remote handle in the worker. You can pass out references to that handle. When the worker is done with a reference, it says “generation 5 released.” Only when both the frontend has no refs and the last released generation equals the last handed-out generation is it safe to actually tear down the pair.

---

### The decorators: registering types for cross-thread construction

Also in src/worker_rpc.ts

- @registerSharedObjectOwner(identifier)
  - Sets RPC_TYPE_ID on the class prototype to the given string (lines ~411–415). This is used when the owner class will initiate a counterpart. On initializeCounterpart, that RPC_TYPE_ID is sent so the other side knows which constructor to call.

- @registerSharedObject(identifier?)
  - Registers a class constructor in a global map keyed by identifier (lines ~425–437). This is meant for counterpart classes (the classes to construct when a “SharedObject.new” message arrives). If you omit the identifier, the class’s prototype must already have RPC_TYPE_ID.

- How they combine:
  - Owner side: a class decorated with @registerSharedObjectOwner("My.Type") will send type: "My.Type" when it calls initializeCounterpart(), which triggers a SharedObject.new RPC.
  - Counterpart side: a class decorated with @registerSharedObject("My.Type") is discoverable by the SharedObject.new handler, which constructs it with (rpc, options).

In the code:
- Owner example (frontend):
  - src/annotation/renderlayer.ts: AnnotationLayerSharedObject is decorated with @registerSharedObjectOwner(ANNOTATION_RENDER_LAYER_RPC_ID) and calls this.initializeCounterpart(...) to spin up the backend counterpart with the same identifier (lines ~182–201).
- Counterpart example (backend):
  - src/annotation/backend.ts has @registerSharedObject(ANNOTATION_RENDER_LAYER_RPC_ID) on the class that implements the backend side of that layer (see search results). When SharedObject.new arrives with that id, this class is constructed.

This pattern appears broadly across the codebase for chunk sources, mesh layers, slice views, credentials, etc. See search results for @registerSharedObject and @registerSharedObjectOwner.

---

### Example: sharing visibility across threads with a mixin

Files:
- src/visibility_priority/frontend.ts
- src/visibility_priority/backend.ts

withSharedVisibility is a mixin that augments a SharedObject-based class with a “visibility” property that’s actually a shared, cross-thread WatchableValue. It demonstrates how to embed another shared object inside your own options during initializeCounterpart.

- Frontend side mixin (owner):
  - Adds visibility = new VisibilityPriorityAggregator() (an aggregator of watchable priorities).
  - In initializeCounterpart, it constructs a SharedWatchableValue from the existing WatchableValue and injects the rpcId into options.visibility before calling super.initializeCounterpart (frontend.ts lines ~96–105). This means the backend will receive an rpc id to a SharedWatchableValue.

- Backend side mixin (counterpart):
  - In constructor(rpc, options), it grabs the shared watchable from rpc.get(options.visibility), subscribes to changes, and reacts (e.g., reprioritize chunk requests) (backend.ts lines ~35–46).

So a field in your class can itself be a shared object, referenced by id in the “options” payload used to construct the counterpart.

---

### Example: SharedWatchableValue in detail (a simple shared data container)

File: src/shared_watchable_value.ts

- It’s a counterpart class that implements WatchableValueInterface<T> and is decorated with @registerSharedObject("SharedWatchableValue").
- You typically create one on the owner side via SharedWatchableValue.makeFromExisting(rpc, someWatchableValue). That sets up change listeners that forward updates across the RPC.
- On the counterpart side, the constructor builds a WatchableValue and wires up a handler for a CHANGED_RPC_METHOD_ID so that remote changes update the local WatchableValue (lines ~45–51, 58–74, 104–109).

This is the building block used by withSharedVisibility and also elsewhere when a simple shared scalar or object needs to stay in sync.

---

### Putting it all together: a typical flow

Let’s walk through a concrete case from annotations (simplified):

1) Frontend creates an owner object
  - class AnnotationLayerSharedObject extends withSharedVisibility(...) is decorated with @registerSharedObjectOwner(ANNOTATION_RENDER_LAYER_RPC_ID).
  - Its constructor calls initializeCounterpart(this.chunkManager.rpc, { source: source.rpcId, segmentationStates: ..., visibility: SharedWatchableValue.makeFromExisting(...).rpcId })

2) RPC constructs the backend counterpart
  - The owner call triggers rpc.invoke("SharedObject.new", { id, type: ANNOTATION_RENDER_LAYER_RPC_ID, ...options }).
  - On the backend, the SharedObject.new handler looks up the registered constructor for that id (registered by @registerSharedObject on the backend class) and constructs it with (rpc, options).
  - The backend counterpart receives options.visibility as a reference id and does rpc.get(options.visibility) to obtain the SharedWatchableValue handle for ongoing updates.

3) Runtime updates
  - If frontend changes visibility, SharedWatchableValue sends a CHANGED message; backend’s handler updates its copy and may reprioritize chunk requests.
  - If backend needs to respond with progress or results, it uses RPC handlers or registerPromiseRPC to return data.

4) Cleanup
  - Any references sent to the other side are stamped with a generation (addCounterpartRef()). When the counterpart’s refcount drops to zero, it notifies the owner (SharedObject.refCountReachedZero). When both sides are done for the current generation and the owner’s own refcount is zero, the owner sends SharedObject.dispose, and both sides free their mapping.

---

### How to define your own shared class (step-by-step)

- Decide which side “owns” it (the side that will call initializeCounterpart()).
- On the owner class:
  - Decorate: @registerSharedObjectOwner("my.unique.type")
  - Derive from SharedObject or a mixin that includes it (e.g., withSharedVisibility(SharedObject)).
  - In your constructor, call this.initializeCounterpart(rpc, { ...options }) and include any nested shared object ids (e.g., visibility: SharedWatchableValue.makeFromExisting(rpc, myWatchable).rpcId).

- On the counterpart class (other thread):
  - Decorate: @registerSharedObject("my.unique.type")
  - Derive from SharedObjectCounterpart or another mixin chain suitable for the backend (e.g., withSharedVisibility(ChunkRequesterBase)).
  - In the constructor(rpc, options), read back nested shared objects using rpc.get(options.someSharedId) and wire up listeners.

- For request/response operations, expose named RPC endpoints:
  - registerPromiseRPC("MyType.doThing", function (x, { signal, progressListener }) { … return Promise<{ value, transfers? }>; })
  - From the caller side, await rpc.promiseInvoke("MyType.doThing", { … }, { signal, progressListener })

---

### Debugging tips

- Confirm the type id matches on both sides
  - The string passed to @registerSharedObject on the counterpart must match the RPC_TYPE_ID of the owner class (or the string you gave to @registerSharedObjectOwner). Mismatches lead to SharedObject.new failing to find a constructor.

- Check map sizes and ids
  - RPC keeps a map of id -> object on each side. If you leak references, numObjects will grow. The debug logs (guarded by DEBUG) can help trace lifecycle.

- Progress/cancel plumbing
  - If you pass a progressListener to promiseInvoke, ensure the backend handler is registered with registerPromiseRPC and that it uses the provided progressListener to add/remove spans. Cancellation will call abortController.abort() on the backend.

- Be careful with structured clone
  - Payloads sent via rpc.invoke must be structured-cloneable. If you need to share a non-cloneable resource, wrap it as a SharedObject and pass ids instead.

---

### Pointers to concrete code you can read next

- RPC core, SharedObject lifecycle, and decorators:
  - src/worker_rpc.ts

- A minimal, reusable shared value:
  - src/shared_watchable_value.ts

- A realistic composite use (visibility sharing):
  - src/visibility_priority/frontend.ts (owner side mixin)
  - src/visibility_priority/backend.ts (counterpart side mixin)

- End-to-end example around a real feature:
  - Owner side: src/annotation/renderlayer.ts (AnnotationLayerSharedObject, @registerSharedObjectOwner)
  - Counterpart side: src/annotation/backend.ts (classes with @registerSharedObject matching the same ids)

If you want, tell me which class or feature you plan to modify (e.g., voxel annotation buffering), and I’ll map out the exact owner/counterpart classes and the RPC surface you’ll need to extend.

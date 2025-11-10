# Why does Neuroglancer need a custom gc?

## AI-resume

Neuroglancer employs a custom reference-counting system, implemented in `disposable.ts`, to manage the lifetimes of critical resources like WebGL textures, event listeners, and remote worker objects. This system complements JavaScript's built-in garbage collector by providing deterministic cleanup of non-memory resources that the GC cannot handle on its own.

## Practicale example - WebGL texture management

See this stackoverflow post:
https://stackoverflow.com/questions/58499937/are-webgl-objects-garbage-collected

#### Are WebGL objects garbage collected?

In JavaScript memory that I allocated (e.g. an ArrayBuffer) gets freed up when I don't have any reference to it anymore by the GC as I understood that right?

WebGL objects like Buffers or Textures are associated with a memory block on the GPU as allocated by gl.bufferData() or gl.textureImage2D().

I'm wondering: if I give up my last reference to a WebGLTexture or WebGLBuffer object, does it get garbage collected with its GPU memory block freed by the JavaScript VM automatically?

#### Response

Yes and no.

Yes they are garbage collected. But garbage collection happens whenever the browser decides to collect them. From the POV of most browser JavaScript engines the WebGLObject object is a tiny object that just contains an int so it has no easy way to know of any special pressure to collect it. In other words when the GPU runs out of memory the JavaScript garbage collector, which has no connection to the GPU, has no way of knowing that it needs to free these tiny WebGLObject objects in order to free up texture memory. It's only looking at CPU memory.

This is actually a well known problem of garbage collection. It's great for memory. It's not so great for other resources.

So, yes, WebGLObject objects are garbage collected and yes the texture/buffer/renderbuffer/program/shader will be freed but practically speaking you need to delete them yourself if you don't want to run out of memory.

Of course the browser will free them all if you refresh the page or visit a new page in the same tab but you can't count on the browser to garbage collect WebGLObject objects (textures/buffers/renderbuffers/programs/shaders) in any useful way.

## What’s in util/disposable.ts

It’s not a general-purpose GC. It provides:

- A Disposable interface: anything with dispose(): void.
- RefCounted: a base class with addRef() and dispose() that decrements a refCount, and when it reaches zero runs registered cleanup actions.
- Disposer helpers:
  - registerDisposer(() => void | Disposable) to collect cleanup actions.
  - invokeDisposers in reverse order for safe teardown.
  - registerEventListener(target, type, listener, options) that returns an unregister function (and RefCounted.registerEventListener wraps it so it’s auto-removed on dispose).
  - registerCancellable(cancellable) to call cancel() during dispose.
  - disposableOnce(...) to guard one-time cleanup.
- Owned<T> / Borrowed<T> type aliases to express ownership semantics in function signatures (convention: Owned donates a reference; Borrowed does not increase refCount).
- Debug aids (DEBUG_REF_COUNTS, disposedStacks) for leak/early-dispose diagnosis.

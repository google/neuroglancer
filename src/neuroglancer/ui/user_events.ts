import {RefCounted} from 'neuroglancer/util/disposable';

interface TypedEventListener<T> extends EventListener {
  (e: T): void;
}

type ListenerConfig<T> = TypedEventListener<T>|[TypedEventListener<T>, boolean];

// Used to perform type narrowing on a ListenerConfig.
function getListenerConfig<T>(listenerConfig: ListenerConfig<T>):
    [TypedEventListener<T>, boolean | undefined] {
  if (Array.isArray(listenerConfig)) {
    return listenerConfig;
  } else {
    return [listenerConfig, false];
  }
}

// Flatten and type narrow disposers.
function getDisposerList<T>(inputDisposers: Disposers | DisposerRef[] | DisposerRef):
    DisposerRef[] {
  if (Array.isArray(inputDisposers)) {
    return inputDisposers;
  };
  if (typeof(inputDisposers) === 'function') {
    return [inputDisposers];
  }
  let list = [];
  for (let key of keys(inputDisposers)) {
    list.push(inputDisposers[key]);
  }
  return list;
}

export interface MouseDragEvent extends MouseEvent {
  start: DragPosition;
  current: DragPosition;
  delta: DragPosition;
  target: HTMLElement;
}

export interface DomEvents {
  mousemove?: ListenerConfig<MouseEvent>;
  mousedown?: ListenerConfig<MouseEvent>;
  mouseleave?: ListenerConfig<MouseEvent>;
  mouseup?: ListenerConfig<MouseEvent>;
  dblclick?: ListenerConfig<MouseEvent>;
  wheel?: ListenerConfig<WheelEvent>;
  click?: ListenerConfig<MouseEvent>;
}

export interface CustomEvents {
  // Custom, non-dom events.
  mousedrag?: ListenerConfig<MouseDragEvent>;
}

type CustomListeners = {
  [K in keyof CustomEvents]: CustomEvents[K][];
}

export const CUSTOM_EVENT_TYPES: [keyof CustomEvents] = [
  'mousedrag',
];

export interface EventConfig extends DomEvents, CustomEvents {}

function keys<T>(obj: T): [keyof T] {
  return Object.keys(obj) as any;
}

type ListenerType = EventConfig[keyof EventConfig];
type DisposerRef = () => void;
type Disposers = {
  [K in keyof EventConfig]: DisposerRef;
}

type DragPosition = {
  x: number,
  y: number
};

export class UserEventEmitter extends RefCounted {
  dragging = false;

  private dragStart: DragPosition|null = null;
  private dragLast: DragPosition;
  private dragDisposers: Disposers = {};

  private customListeners: CustomListeners = {};
  private activeListeners = new Map<DisposerRef, ListenerType>();

  constructor(private element: HTMLElement) {
    super();

    // Must stay in constructor to ensure that it is called before any subsequent handlers.
    this.on({
      mousedown: this.onMousedown.bind(this),
    });
  }

  on(eventConfig: EventConfig, element: EventTarget = this.element): Disposers {
    let disposers: Disposers = {};
    for (let key of keys(eventConfig)) {
      let listener = eventConfig[key];
      if (listener === undefined) {
        continue;
      }
      let disposer: DisposerRef;
      if (CUSTOM_EVENT_TYPES.indexOf(key as any) < 0) {
        disposer = this.addDomListener(element, key, listener);
      } else {
        disposer = this.addCustomListener(element, key as any, listener);
      }

      this.activeListeners.set(disposer, listener);
      disposers[key] = disposer;
    }
    return disposers;
  }

  off(inputDisposers: Disposers|DisposerRef[]|DisposerRef) {
    let disposers = getDisposerList(inputDisposers);
    for (let disposer of disposers) {
      disposer();
    }
  }

  disposed() {
    for (let disposer of this.activeListeners.keys()) {
      disposer();
    }
    super.dispose();
  }

  private addDomListener<T>(
      element: EventTarget, key: keyof EventConfig, listenerConfig: ListenerConfig<T>) {
    let [listener, useCapture] = getListenerConfig(listenerConfig);


    element.addEventListener(key, listener, useCapture);
    let disposer = () => {
      element.removeEventListener(key, listener);
      if (this.activeListeners.has(disposer)) {
        this.activeListeners.delete(disposer);
      }
    };
    return disposer;
  }

  private addCustomListener<T>(
      element: EventTarget, key: keyof CustomEvents, listenerConfig: ListenerConfig<T>) {
    element;
    let [listener] = getListenerConfig(listenerConfig);

    if (!this.customListeners[key]) {
      this.customListeners[key] = [];
    }
    this.customListeners[key].push(listener);
    let disposer = () => {
      this.customListeners[key] = this.customListeners[key].filter(l => l !== listener);
    };
    return disposer;
  }

  private onMousedown(e: MouseEvent) {
    this.dragLast = this.dragStart = {
      x: e.screenX,
      y: e.screenY,
    };

    this.dragDisposers = this.on(
        {
          mousemove: this.onMousedrag.bind(this),
          mouseup: this.onMousedragend.bind(this),
        },
        document);
  }

  private onMousedragend() {
    this.dragging = false;
    this.dragStart = null;
    this.off(this.dragDisposers);
    this.dragDisposers = {};
  }

  private onMousedrag(e: MouseEvent) {
    this.dragging = true;
    if (!this.dragStart) {
      return;
    }
    let dragCurrent: DragPosition = {
      x: e.screenX,
      y: e.screenY,
    };
    let delta: DragPosition = {
      x: this.dragLast.x - dragCurrent.x,
      y: this.dragLast.y - dragCurrent.y,
    };
    this.dragLast = dragCurrent;

    let dragEvent: MouseDragEvent = {
      ...e,
      start: this.dragStart,
      current: dragCurrent,
      delta,
      target: this.element,
      // Need to set some manually here, since you can't enumerate Event properties :(
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
    };

    this.customListeners['mousedrag'].forEach(listenerConfig => {
      if (listenerConfig) {
        let [listener] = getListenerConfig(listenerConfig);
        listener(dragEvent);
      }
    });
  }
}
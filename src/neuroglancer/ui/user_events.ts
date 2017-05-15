import {RefCounted} from 'neuroglancer/util/disposable';

interface TypedEventListener<T> extends EventListener {
  (e: T): void;
}

type ListenerConfig<T> = TypedEventListener<T> | [TypedEventListener<T>, boolean];

// Used to perform type narrowing on a ListenerConfig.
function getListenerConfig<T>(listenerConfig: ListenerConfig<T>): [TypedEventListener<T>, boolean|undefined] {
    if (Array.isArray(listenerConfig)) {
      return listenerConfig;
    } else {
      return [listenerConfig, false];
    }
}

interface EventConfig {
  mousemove?: ListenerConfig<MouseEvent>;
  mousedown?: ListenerConfig<MouseEvent>;
  mouseleave?: ListenerConfig<MouseEvent>;
  dblclick?: ListenerConfig<Event>;
}

function keys<T>(obj: T): [keyof T] {
  return Object.keys(obj) as any;
}

type ListenerType = EventConfig[keyof EventConfig];
type DisposerRef = () => void;
type Disposers = {
  [K in keyof EventConfig]: DisposerRef;
}

export class UserEventEmitter extends RefCounted {

  private activeListeners = new Map<DisposerRef, ListenerType>();

  constructor(private element: HTMLElement) {
    super();
  }

  on(eventConfig: EventConfig) {
    let disposers: Disposers = {};
    for (let key of keys(eventConfig)) {
      let {element} = this;
      let listenerConfig = eventConfig[key];
      if (listenerConfig === undefined) {
        continue;
      }
      let [listener, useCapture] = getListenerConfig(listenerConfig);
      element.addEventListener(key, listener, useCapture)
      let disposer = () => {
        element.removeEventListener(key, listener);
        this.removeDisposer(disposer);
      }
      this.activeListeners.set(disposer, listener);
      disposers[key] = disposer;
    }
    return disposers;
  }

  off(disposers: DisposerRef[]|DisposerRef) {
    if (!Array.isArray(disposers)) {
      disposers = [disposers];
    }

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

  private removeDisposer(disposer: DisposerRef) {
    if(this.activeListeners.has(disposer)) {
      this.activeListeners.delete(disposer);
    }
  }
}
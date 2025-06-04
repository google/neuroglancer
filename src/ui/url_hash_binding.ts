/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { DebouncedFunc } from "lodash-es";
import { debounce } from "lodash-es";
import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import {
  bigintToStringJsonReplacer,
  urlSafeParse,
  verifyObject,
} from "#src/util/json.js";
import { getCachedJson } from "#src/util/trackable.js";
import type { Viewer } from "#src/viewer.js";

/**
 * @file Implements a binding between a Trackable value and the URL hash state.
 */

/**
 * Encodes a fragment string robustly.
 */
export function encodeFragment(fragment: string) {
  return encodeURI(fragment).replace(
    /[!'()*;,]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export interface UrlHashBindingOptions {
  defaultFragment?: string;
  updateDelayMilliseconds?: number;
}

const dynamicDebounce = (
  func: () => any,
  wait: WatchableValue<number>,
  ref: RefCounted,
) => {
  let debouncedFunc: DebouncedFunc<() => void> | undefined = undefined;
  const updateDebounce = () => {
    if (ref.wasDisposed) return;
    debouncedFunc?.flush();
    debouncedFunc = debounce(func, wait.value, { maxWait: wait.value * 2 });
  };
  ref.registerDisposer(wait.changed.add(updateDebounce));
  updateDebounce();

  return Object.assign(
    () => {
      return debouncedFunc!();
    },
    {
      cancel: () => {
        debouncedFunc?.cancel();
      },
    },
  );
};

/**
 * An instance of this class manages a binding between a Trackable value and the URL hash state.
 * The binding is initialized in the constructor, and is removed when dispose is called.
 */
export class UrlHashBinding extends RefCounted {
  /**
   * Most recently parsed or set state string.
   */
  private prevStateString: string | undefined;

  /**
   * Generation number of previous state set.
   */
  private prevStateGeneration: number | undefined;

  /**
   * Most recent error parsing URL hash.
   */
  parseError = new WatchableValue<Error | undefined>(undefined);

  private defaultFragment: string;

  get root() {
    return this.viewer.state;
  }

  get sharedKvStoreContext() {
    return this.viewer.dataSourceProvider.sharedKvStoreContext;
  }

  private blurred: boolean = false;

  constructor(
    private viewer: Viewer,
    options: UrlHashBindingOptions = {},
  ) {
    super();
    const { defaultFragment = "{}" } = options;

    const { root } = this;

    this.registerEventListener(window, "hashchange", () =>
      this.updateFromUrlHash(),
    );

    const throttledSetUrlHash = dynamicDebounce(
      () => this.setUrlHash(),
      viewer.urlRateLimit,
      this,
    );

    this.registerDisposer(root.changed.add(throttledSetUrlHash));
    this.registerDisposer(() => throttledSetUrlHash.cancel());

    this.registerDisposer(
      this.viewer.saveStateUrl.changed.add(() => {
        if (this.viewer.saveStateUrl.value) {
          this.setUrlHash();
        } else {
          history.replaceState(null, "", "#");
        }
      }),
    );

    // TODO, move out of url_hash_bindings?
    window.addEventListener("beforeunload", () => {
      if (!this.viewer.saveStateSession.value) return;
      const cacheState = getCachedJson(this.root);
      const stateString = JSON.stringify(
        cacheState.value,
        bigintToStringJsonReplacer,
      );
      window.sessionStorage.setItem("state", stateString);
    });

    window.addEventListener("blur", () => {
      this.blurred = true;
      this.setUrlHash(true);
    });

    window.addEventListener("focusin", () => {
      this.blurred = false;
    });

    this.defaultFragment = defaultFragment;
  }

  /**
   * Sets the URL hash to match the current state.
   */
  setUrlHash(force = false) {
    // prevent updates when blurred to avoid interfering with copying the url
    if (!force && this.blurred) {
      return;
    }
    if (!this.viewer.saveStateUrl.value) {
      this.prevStateGeneration = undefined;
      this.prevStateString = undefined;
      return history.replaceState(null, "", "#");
    }
    const cacheState = getCachedJson(this.root);
    const { generation } = cacheState;
    if (generation !== this.prevStateGeneration) {
      this.prevStateGeneration = cacheState.generation;
      const stateString = encodeFragment(
        JSON.stringify(cacheState.value, bigintToStringJsonReplacer),
      );
      if (stateString !== this.prevStateString) {
        this.prevStateString = stateString;
        this.viewer.urlLastUpdatedTime.value = performance.now();
        if (decodeURIComponent(stateString) === "{}") {
          history.replaceState(null, "", "#");
        } else {
          history.replaceState(null, "", "#!" + stateString);
        }
      }
    }
  }

  /**
   * Sets the current state to match the URL hash.  If it is desired to initialize the state based
   * on the URL hash, then this should be called immediately after construction.
   */
  updateFromUrlHash() {
    const sessionStateString = window.sessionStorage.getItem("state");
    window.sessionStorage.removeItem("state");
    try {
      let s = location.href.replace(/^[^#]+/, "");
      if (s === "" || s === "#" || s === "#!") {
        s = "#!" + this.defaultFragment;
      }
      // Handle remote JSON state
      if (s.match(/^#!([a-z][a-z\d+-.]*):\/\//)) {
        const url = s.substring(2);
        StatusMessage.forPromise(
          this.sharedKvStoreContext.kvStoreContext
            .read(url, { throwIfMissing: true })
            .then((response) => response.response.json())
            .then((json) => {
              verifyObject(json);
              this.root.reset();
              this.root.restoreState(json);
            }),
          {
            initialMessage: `Loading state from ${url}`,
            errorPrefix: "Error loading state:",
          },
        );
      } else if (sessionStateString) {
        const json = JSON.parse(sessionStateString);
        this.prevStateString = encodeFragment(json);
        verifyObject(json);
        this.root.reset();
        this.root.restoreState(json);
      } else if (s.startsWith("#!+")) {
        s = s.slice(3);
        // Firefox always %-encodes the URL even if it is not typed that way.
        s = decodeURIComponent(s);
        const state = urlSafeParse(s);
        verifyObject(state);
        this.root.restoreState(state);
        this.prevStateString = undefined;
      } else if (s.startsWith("#!")) {
        s = s.slice(2);
        s = decodeURIComponent(s);
        if (s === this.prevStateString) {
          return;
        }
        this.prevStateString = s;
        this.root.reset();
        const state = urlSafeParse(s);
        verifyObject(state);
        this.root.restoreState(state);
      } else {
        throw new Error(
          `URL hash is expected to be of the form "#!{...}" or "#!+{...}".`,
        );
      }
      this.parseError.value = undefined;
    } catch (parseError) {
      this.parseError.value = parseError;
    }
  }
}

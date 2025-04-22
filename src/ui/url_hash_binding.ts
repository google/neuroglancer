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

import { StatusMessage } from "#src/status.js";
import { WatchableValue } from "#src/trackable_value.js";
import { dynamicDebounce } from "#src/util/debounce.js";
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
function encodeFragment(fragment: string) {
  return encodeURI(fragment).replace(
    /[!'()*;,]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export interface UrlHashBindingOptions {
  defaultFragment?: string;
  updateDelayMilliseconds?: number;
}

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

  urlHashRateLimit = new WatchableValue(200);

  constructor(
    public viewer: Viewer,
    // public root: Trackable,
    // public sharedKvStoreContext: SharedKvStoreContext,
    options: UrlHashBindingOptions = {},
  ) {
    super();
    const { defaultFragment = "{}" } = options;
    this.registerEventListener(window, "hashchange", () =>
      this.updateFromUrlHash(),
    );
    const throttledSetUrlHash = this.registerDisposer(
      dynamicDebounce(
        () => this.setUrlHash(),
        this.urlHashRateLimit,
        (wait) => ({ maxWait: wait }),
      ),
    );
    this.registerDisposer(this.root.changed.add(throttledSetUrlHash));
    // try to update the url before the user might attempt to be copying it
    window.addEventListener("blur", () => {
      throttledSetUrlHash.flush();
    });
    // mouseleave works better (occurs earlier) than blur
    document.addEventListener("mouseleave", () => {
      throttledSetUrlHash.flush();
    });
    // update url for the select url shortcut (ctrl+l/cmd+l)
    // select url triggers the blur event, but for chrome, it occurs too late for the url to be updated
    // alo testing out ctrl+s/cmd+s to update url
    window.addEventListener("keydown", (event) => {
      if (event.key === "l") {
        throttledSetUrlHash.flush();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        throttledSetUrlHash.flush();
      }
    });
    this.defaultFragment = defaultFragment;
    this.viewer.urlHashRateLimit.changed.add(this.updateRateLimit);

    this.registerDisposer(
      this.viewer.saveStateSession.changed.add(() => {
        throttledSetUrlHash.flush();
      }),
    );

    window.addEventListener("beforeunload", () => {
      if (!this.viewer.saveStateSession.value) return;
      const cacheState = getCachedJson(this.root);
      const stateString = JSON.stringify(
        cacheState.value,
        bigintToStringJsonReplacer,
      );
      window.sessionStorage.setItem("state", stateString);
    });
  }

  updateRateLimit = () => {
    const debugEl =
      document.body.querySelector("#debug-url-rate") ??
      document.body.appendChild(document.createElement("div"));
    debugEl.id = "debug-url-rate";

    const userFunc = this.viewer.urlHashRateLimit.value;
    const safeFunc = /^[xelogmaxin ,*/+\-\d()]*$/;
    if (safeFunc.test(userFunc)) {
      const translatedFunc = userFunc
        .replaceAll("log", "Math.log")
        .replaceAll("min", "Math.min")
        .replaceAll("max", "Math.max")
        .replaceAll("e", "Math.E");
      this.urlHashRateLimit.value = eval(
        `'use strict';(x) => ${translatedFunc}`,
      )(this.prevStateString?.length ?? 0);
      debugEl.textContent = `URL rate: ${(this.urlHashRateLimit.value / 1000).toFixed(1)} s (state size (x)=${this.prevStateString?.length ?? 0}, f=${this.viewer.urlHashRateLimit.value})`;
    } else {
      debugEl.textContent = `URL rate: INVALID FUNCTION (${userFunc})`;
    }
  };

  /**
   * Sets the URL hash to match the current state.
   */
  setUrlHash() {
    const cacheState = getCachedJson(this.root);
    const { generation } = cacheState;
    if (generation !== this.prevStateGeneration) {
      this.prevStateGeneration = cacheState.generation;
      const stateString = encodeFragment(
        JSON.stringify(cacheState.value, bigintToStringJsonReplacer),
      );
      if (stateString !== this.prevStateString) {
        this.prevStateString = stateString;
        this.updateRateLimit();
        StatusMessage.showTemporaryMessage(`URL updated! (debug)`);
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

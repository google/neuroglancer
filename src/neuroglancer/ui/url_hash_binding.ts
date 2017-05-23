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

import debounce from 'lodash/debounce';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {urlSafeParse, urlSafeStringify, verifyObject} from 'neuroglancer/util/json';
import {getCachedJson, Trackable} from 'neuroglancer/util/trackable';

/**
 * @file Implements a binding between a Trackable value and the URL hash state.
 */

/**
 * Keycloak authentication (used for the Boss datasource) has the unfortunate side effect of moving the fragment string into a query parameter. Here we check to see if the `redirect_fragment` query string field is set. If so, we move the contents from the query string into the hash.
 */
export function parseHashFromQueryString() {
  let params = new URLSearchParams(window.location.search.substring(1));
  let stateString = params.get("redirect_fragment");
  if (stateString) {
    history.replaceState(null, '', '#' + stateString);
  }
}

/**
 * An instance of this class manages a binding between a Trackable value and the URL hash state.
 * The binding is initialized in the constructor, and is removed when dispose is called.
 */
export class UrlHashBinding extends RefCounted {
  /**
   * Most recently parsed or set state string.
   */
  private prevStateString: string|undefined;

  /**
   * Generation number of previous state set.
   */
  private prevStateGeneration: number|undefined;

  /**
   * Most recent error parsing URL hash.
   */
  parseError = new WatchableValue<Error|undefined>(undefined);

  constructor(public root: Trackable, updateDelayMilliseconds = 200) {
    super();
    this.registerEventListener(window, 'hashchange', () => this.updateFromUrlHash());
    const throttledSetUrlHash = debounce(() => this.setUrlHash(), updateDelayMilliseconds);
    this.registerDisposer(root.changed.add(throttledSetUrlHash));
    this.registerDisposer(() => throttledSetUrlHash.cancel());
  }

  /**
   * Sets the URL hash to match the current state.
   */
  setUrlHash() {
    const cacheState = getCachedJson(this.root);
    const {generation} = cacheState;
    if (generation !== this.prevStateGeneration) {
      this.prevStateGeneration = cacheState.generation;
      let stateString = urlSafeStringify(cacheState.value);
      if (stateString !== this.prevStateString) {
        this.prevStateString = stateString;
        if (stateString === '{}') {
          history.replaceState(null, '', '#');
        } else {
          history.replaceState(null, '', '#!' + stateString);
        }
      }
    }
  }

  /**
   * Sets the current state to match the URL hash.  If it is desired to initialize the state based
   * on the URL hash, then this should be called immediately after construction.
   */
  updateFromUrlHash() {
    try {
      let s = location.href.replace(/^[^#]+/, '');
      if (s === '' || s === '#' || s === '#!') {
        s = '#!{}';
      }
      if (s.startsWith('#!+')) {
        s = s.slice(3);
        // Firefox always %-encodes the URL even if it is not typed that way.
        s = decodeURI(s);
        let state = urlSafeParse(s);
        verifyObject(state);
        this.root.restoreState(state);
        this.prevStateString = undefined;
      } else if (s.startsWith('#!')) {
        s = s.slice(2);
        s = decodeURI(s);
        if (s === this.prevStateString) {
          return;
        }
        this.prevStateString = s;
        this.root.reset();
        let state = urlSafeParse(s);
        verifyObject(state);
        this.root.restoreState(state);
      } else {
        throw new Error(`URL hash is expected to be of the form "#!{...}" or "#!+{...}".`);
      }
      this.parseError.value = undefined;
    } catch (parseError) {
      this.parseError.value = parseError;
    }
  }
}

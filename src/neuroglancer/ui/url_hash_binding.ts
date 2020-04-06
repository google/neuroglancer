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

import {debounce} from 'lodash';
import {dismissUnshareWarning, getUnshareWarning} from 'neuroglancer/preferences/user_preferences';
import {StatusMessage} from 'neuroglancer/status';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {urlSafeParse, verifyObject} from 'neuroglancer/util/json';
import {getCachedJson, Trackable} from 'neuroglancer/util/trackable';
import {Viewer} from 'neuroglancer/viewer';

/**
 * @file Implements a binding between a Trackable value and the URL hash state.
 */

export function removeParameterFromUrl(url: string, parameter: string) {
  return url.replace(new RegExp('[?&]' + parameter + '=[^&#]*(#.*)?$'), '$1')
      .replace(new RegExp('([?&])' + parameter + '=[^&]*&'), '$1');
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
   * Most recent error parsing URL hash.
   */
  parseError = new WatchableValue<Error|undefined>(undefined);
  legacy: UrlHashBindingLegacy;
  constructor(public root: Trackable, public viewer: Viewer) {
    super();
    this.registerEventListener(window, 'hashchange', () => this.updateFromUrlHash());
    this.legacy = new UrlHashBindingLegacy(root, this, this.prevStateString);
  }
  /**
   * Sets the current state to match the URL hash.  If it is desired to initialize the state based
   * on the URL hash, then this should be called immediately after construction.
   */
  updateFromUrlHash() {
    try {
      let s = location.href.replace(/^[^#]+/, '');
      if (s === '' || s === '#' || s === '#!') {
        // s = '#!{}';
        return;
      }
      StatusMessage.showTemporaryMessage(
          `RAW URLs will soon be Deprecated. Please use JSON URLs whenever available.`, 10000);
      if (getUnshareWarning().value) {
        StatusMessage.messageWithAction(
            `This state has not been shared, share and copy the JSON or RAW url to avoid losing progress. `,
            [
              {
                message: 'Dismiss',
                action: () => {
                  dismissUnshareWarning();
                  StatusMessage.showTemporaryMessage(
                      'To reenable this warning, check "Unshared state warning" in the User Preferences menu.',
                      5000);
                }
              },
              {message: 'Share', action: () => this.viewer.postJsonState(true)}
            ],
            undefined, {color: 'yellow'});
      }
      if (s.startsWith('#!+')) {
        s = s.slice(3);
        // Firefox always %-encodes the URL even if it is not typed that way.
        s = decodeURIComponent(s);
        let state = urlSafeParse(s);
        verifyObject(state);
        this.root.restoreState(state);
        this.prevStateString = undefined;
      } else if (s.startsWith('#!')) {
        s = s.slice(2);
        s = decodeURIComponent(s);
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
  returnURLHash() {
    const cacheState = getCachedJson(this.root);
    return this.legacy.encodeFragment(JSON.stringify(cacheState.value));
  }
}

class UrlHashBindingLegacy {
  // No localStorage fallback (Neuroglancer is currently inoperable w/o localStorage)
  constructor(
      public root: Trackable, public parent: UrlHashBinding,
      private prevStateString: string|undefined) {}
  /**
   * Generation number of previous state set.
   */
  private prevStateGeneration: number|undefined;
  /**
   * Encodes a fragment string robustly.
   */
  encodeFragment(fragment: string) {
    return encodeURI(fragment).replace(/[!'()*;,]/g, function(c) {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }
  /**
   * Sets url hash event handler, in case saver is deactivated.
   */
  fallback(updateDelayMilliseconds = 400) {
    const throttledSetUrlHash = debounce(() => this.setUrlHash(), updateDelayMilliseconds);
    this.parent.registerDisposer(this.root.changed.add(throttledSetUrlHash));
    this.parent.registerDisposer(() => throttledSetUrlHash.cancel());
  }
  /**
   * Sets the URL hash to match the current state.
   */
  setUrlHash() {
    const cacheState = getCachedJson(this.root);
    const {generation} = cacheState;
    // Suggestion: Change to recurring, onblur and time, or onunload save and push to state server
    // Counterpoint: No point optimizing deprecated code
    let cleanURL = removeParameterFromUrl(
        removeParameterFromUrl(window.location.href, 'json_url'), 'local_id');
    history.replaceState(null, '', cleanURL);

    if (generation !== this.prevStateGeneration) {
      this.prevStateGeneration = cacheState.generation;
      let stateString = this.encodeFragment(JSON.stringify(cacheState.value));
      if (stateString !== this.prevStateString) {
        this.prevStateString = stateString;
        if (decodeURIComponent(stateString) === '{}') {
          history.replaceState(null, '', '#');
        } else {
          history.replaceState(null, '', '#!' + stateString);
        }
      }
    }
  }
}

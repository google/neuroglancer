import 'neuroglancer/save_state/save_state.css';

import {debounce} from 'lodash';
import {Overlay} from 'neuroglancer/overlay';
import {dismissUnshareWarning, getSaveToAddressBar, getUnshareWarning} from 'neuroglancer/preferences/user_preferences';
import {StatusMessage} from 'neuroglancer/status';
import {RefCounted} from 'neuroglancer/util/disposable';
import {getRandomHexString} from 'neuroglancer/util/random';
import {Trackable} from 'neuroglancer/util/trackable';
import {UrlType, Viewer} from 'neuroglancer/viewer';

const deprecatedKey = 'neuroglancerSaveState';
const stateKey = 'neuroglancerSaveState_v2';
const historyKey = 'neuroglancerSaveHistory';
// TODO: Remove state ID from URL and preserve updated state order, or use timestamp
// const orderKey = 'neuroglancerSaveOrder';

export class SaveState extends RefCounted {
  key?: string;
  session_id = getRandomHexString();
  savedUrl?: string;
  supported = true;
  constructor(public root: Trackable, public viewer: Viewer, updateDelayMilliseconds = 400) {
    super();
    const userDisabledSaver = getSaveToAddressBar().value;

    if (storageAccessible()) {
      this.loadFromKey();
      this.registerEventListener(window, 'popstate', () => this.loadFromKey());
    } else {
      this.supported = false;
      StatusMessage.messageWithAction(
          `Warning: Cannot access Local Storage. Unsaved changes will be lost! Use OldStyleSaving to allow for auto saving.`,
          [{message: 'Ok'}], 30000, {color: 'red'});
    }
    if (userDisabledSaver) {
      this.supported = false;
      StatusMessage.showTemporaryMessage(
          `Save State has been disabled because Old Style saving has been turned on in User Preferences.`,
          10000, {color: 'orange'});
    } else {
      const throttledUpdate = debounce(() => this.push(), updateDelayMilliseconds);
      this.registerDisposer(root.changed.add(throttledUpdate));
      this.registerDisposer(() => throttledUpdate.cancel());
      window.addEventListener('focus', (() => this.push()).bind(this));
    }
  }
  // Main Methods
  pull() {
    // Get SaveEntry from localStorage
    if (storageAccessible() && this.key) {
      const entry = localStorage[`${stateKey}-${this.key}`];
      if (entry) {
        return JSON.parse(entry);
      }
    }
    return;
  }
  push(clean?: boolean) {
    // update SaveEntry in localStorage
    if (storageAccessible() && this.key) {
      const source = <SaveEntry>this.pull() || {};
      if (source.history && source.history.length) {
        // history should never be empty
        if (this.reassign(source)) {
          source.history = [];
        }
        source.history = this.uniquePush(source.history, this.session_id);
      } else {
        source.history = [this.session_id];
      }
      const oldState = this.root.toJSON();
      const stateChange = JSON.stringify(oldState) !== JSON.stringify(source.state);

      if (stateChange || clean) {
        source.state = oldState;
        // if clean is true, then this state is committed, and not dirty.
        source.dirty = clean ? !clean : true;
        const serializedUpdate = JSON.stringify(source);
        this.robustSet(`${stateKey}-${this.key}`, serializedUpdate);
      }
      this.setSaveStatus(source.dirty);
      this.notifyManager();
    }
  }
  commit(source_url: string) {
    if (this.key) {
      this.savedUrl = source_url;
      this.addToHistory(recordHistory(source_url));
      this.push(true);
    }
  }
  loadFromKey() {
    const params = new URLSearchParams(window.location.search);
    this.key = <any>params.get('local_id');

    if (this.key) {
      location.hash = '';
      let entry = this.pull();
      // TODO: REMOVE BACKWARD COMPATIBILITY
      if (!entry) {
        const oldDatabaseRaw = localStorage[deprecatedKey];
        const oldDatabase = JSON.parse(oldDatabaseRaw || '{}');
        entry = oldDatabase[this.key];
        delete oldDatabase[this.key];
        const serializedDatabase = JSON.stringify(oldDatabase);
        this.robustSet(deprecatedKey, serializedDatabase);
      }

      if (entry) {
        this.setSaveStatus(entry.dirty);
        this.root.restoreState(entry.state);
        StatusMessage.showTemporaryMessage(
            `Loaded from local storage. Do not duplicate this URL.`, 4000);
        if (entry.dirty && getUnshareWarning().value) {
          StatusMessage.messageWithAction(
              `This state has not been shared, share and copy the JSON or RAW URL to avoid losing progress. `,
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
      } else {
        StatusMessage.showTemporaryMessage(
            `This URL is invalid. Do not copy the URL in the address bar. Use the save button.`,
            10000, {color: 'red'});
      }
    } else {
      this.setSaveStatus(true);
      this.generateKey();
    }
  }
  // Utility
  purge() {
    if (storageAccessible()) {
      this.overwriteHistory();
    }
  }
  nuke(complete = false) {
    if (storageAccessible()) {
      localStorage[stateKey] = '[]';
      const storage = localStorage;
      const storageKeys = Object.keys(storage);
      const stateKeys =
          complete ? storageKeys : storageKeys.filter(key => key.includes(`${stateKey}-`));
      stateKeys.forEach(target => localStorage.removeItem(target));
    }
  }
  userRemoveEntries(complete = false) {
    this.nuke(complete);
    this.push();
  }
  setSaveStatus(status = false) {
    const button = document.getElementById('neuroglancer-saver-button');
    if (button) {
      button.classList.toggle('dirty', status);
    }
    return status;
  }
  history(): SaveHistory[] {
    const saveHistoryString = localStorage.getItem(historyKey);
    return saveHistoryString ? JSON.parse(saveHistoryString) : [];
  }
  overwriteHistory(newHistory: SaveHistory[] = []) {
    this.robustSet(historyKey, JSON.stringify(newHistory));
  }
  showSaveDialog(viewer: Viewer, jsonString?: string, get?: UrlType) {
    new SaveDialog(viewer, jsonString, get);
  }
  showHistory(viewer: Viewer) {
    new SaveHistoryDialog(viewer, this);
  }
  // Helper
  generateKey() {
    this.key = getRandomHexString();
    const params = new URLSearchParams();
    params.set('local_id', this.key);
    history.pushState({}, '', `${window.location.origin}/?${params.toString()}`);
  }
  reassign(master: any) {
    const hist = <string[]>master.history;
    const lastIndex = hist.length - 1;
    const amILastEditor = hist[lastIndex] === this.session_id;
    if (!amILastEditor && hist.includes(this.session_id)) {
      // someone else is editing the state I am editing
      this.generateKey();
      return true;
    }
    return false;
  }
  robustSet(key: string, data: any) {
    while (true) {
      try {
        localStorage.setItem(key, data);
        break;
      } catch (e) {
        // make space
        const entryCount = this.getManager().length;
        if (entryCount) {
          this.evict();
        } else {
          // if no space avaliable break and warn user
          throw e;
        }
      }
    }
  }
  getManager() {
    const managerRaw = localStorage[stateKey];
    return <string[]>JSON.parse(managerRaw || '[]');
  }
  notifyManager() {
    if (storageAccessible() && this.key) {
      const manager = this.uniquePush(this.getManager(), this.key);
      const serializedManager = JSON.stringify(manager);
      this.robustSet(stateKey, serializedManager);
    }
  }
  evict(count = 1) {
    if (storageAccessible() && this.key) {
      const manager = this.getManager();

      const targets = manager.splice(0, count);
      const serializedManager = JSON.stringify(manager);
      localStorage.setItem(stateKey, serializedManager);
      targets.forEach(key => localStorage.removeItem(`${stateKey}-${key}`));
    }
  }
  addToHistory(entry: SaveHistory) {
    const saveHistory = this.history();
    saveHistory.push(entry);
    if (saveHistory.length > 100) {
      saveHistory.splice(0, 1);
    }
    this.overwriteHistory(saveHistory);
  }
  uniquePush(source: any[], entry: any) {
    const target = source.indexOf(entry);
    if (target > -1) {
      source.splice(target, 1);
    }
    source.push(entry);
    return source;
  }
}

class SaveDialog extends Overlay {
  constructor(public viewer: Viewer, jsonString?: string, getUrlType?: UrlType) {
    super();

    const urlStart = `${window.location.origin}${window.location.pathname}`;
    const jsonUrl = jsonString ? `${urlStart}?json_url=${jsonString}` : `NOT AVAILABLE`;
    const rawUrl = `${urlStart}#!${viewer.hashBinding!.returnURLHash()}`;

    if (getUrlType) {
      const copyString = getUrlType === UrlType.json ? jsonUrl : rawUrl;
      if (copyString !== 'NOT AVAILABLE') {
        const text = document.createElement('input');
        document.body.append(text);
        text.type = 'text';
        text.value = copyString;
        text.select();
        document.execCommand('copy');
        document.body.removeChild(text);
        StatusMessage.showTemporaryMessage(
            `Saved and Copied ${
                getUrlType === UrlType.json ? `JSON Link` : `Full State (RAW) link`} to Clipboard.`,
            5000);
      } else {
        StatusMessage.showTemporaryMessage(
            'Could not generate JSON link.', 2000, {color: 'yellow'});
      }
      this.dispose();
      return;
    }

    let form = document.createElement('form');
    let {content} = this;
    content.style.overflow = 'visible';

    const pushButton = document.createElement('button');
    pushButton.innerText = 'Push State to Server';
    pushButton.title = 'Push to state server to get JSON URL.';
    pushButton.addEventListener('click', () => {
      viewer.promptJsonStateServer('Please enter the state server to access.');
      if (viewer.jsonStateServer.value) {
        pushButton.disabled = true;
        saverToggle(false);
        const restoreSaving = () => {
          try {
            this.dispose();
          } catch {
          }
          saverToggle(true);
        };
        viewer.postJsonState(true, undefined, true, restoreSaving);
      }
    });
    const clearButton = document.createElement('button');
    clearButton.innerText = '⚠️ Clear States';
    clearButton.title = 'Remove all Local States.';
    clearButton.addEventListener('click', () => {
      if (confirm('All unshared or unopened states will be lost. Continue?')) {
        if (viewer.saver) {
          viewer.saver.userRemoveEntries();
        }
      }
    });
    const pushButtonContainer = document.createElement('div');
    pushButtonContainer.style.textAlign = 'right';
    pushButtonContainer.style.marginBottom = '5px';
    pushButtonContainer.append(pushButton, ' ', clearButton);
    content.append(pushButtonContainer);

    let modal = document.createElement('div');
    content.appendChild(modal);

    form.append(this.makePopup('JSON_URL'));
    this.insertField(
        form, 'JSON_URL', jsonUrl, 'neuroglancer-save-state-json', jsonUrl === 'NOT AVAILABLE');
    form.append(document.createElement('br'));
    form.append(this.makePopup('RAW_URL'));
    this.insertField(form, 'RAW_URL', rawUrl, 'neuroglancer-save-state-raw');
    // TODO: Re Deprecate
    // form.append('DEPRECATED');
    modal.appendChild(form);

    modal.onblur = () => this.dispose();
    modal.focus();
  }

  insertField(
      form: HTMLElement, label?: string, content?: string, textId?: string, disabled = false) {
    let labelElement = document.createElement('label');
    labelElement.innerText = label || '';
    let text = document.createElement('input');
    text.readOnly = true;
    text.type = 'text';
    text.value = content || '';
    text.size = 100;
    text.disabled = disabled;
    if (textId) {
      text.id = textId;
    }
    const id = `ng-save-popup-${label || ''}`;
    text.addEventListener('click', () => {
      text.select();
      document.execCommand('copy');
      let popup = document.getElementById(id);
      popup!.classList.add('ng-show');
    });
    text.addEventListener('blur', () => {
      let popup = document.getElementById(id);
      popup!.classList.remove('ng-show');
    });
    form.append(labelElement, ' ', text, document.createElement('br'));
  }

  makePopup(label?: string) {
    let popupContainer = document.createElement('div');
    popupContainer.classList.add('ng-popup');
    let popupContent = document.createElement('span');
    popupContent.classList.add('ng-popuptext');
    popupContent.innerText = 'Copied...';
    popupContent.id = `ng-save-popup-${label || ''}`;
    popupContainer.appendChild(popupContent);
    return popupContainer;
  }
}

class SaveHistoryDialog extends Overlay {
  table = document.createElement('table');
  constructor(public viewer: Viewer, saver: SaveState) {
    super();
    let {content, table} = this;
    if (saver.supported) {
      let saves = saver.history();
      let modal = document.createElement('div');
      content.appendChild(modal);

      table.classList.add('ng-zebra-table');
      saves.reverse().forEach(this.tableEntry.bind(this));

      const clear = document.createElement('button');
      clear.innerText = 'Clear';
      clear.title = 'Remove all saved states.';
      clear.addEventListener('click', () => {
        saver.purge();
        this.dispose();
      });

      modal.append(clear);
      if (!table.children.length) {
        modal.append(document.createElement('br'), `There are no saved states.`);
      }
      modal.append(table);
      modal.onblur = () => this.dispose();
      modal.focus();
    } else {
      this.dispose();
      StatusMessage.showTemporaryMessage(`Cannot access saved states.`, 10000);
    }
  }

  tableEntry(entry: SaveHistory) {
    if (!entry || !entry.source_url) {
      return;
    }
    const row = document.createElement('tr');
    const date = document.createElement('td');
    const link = document.createElement('td');
    const linkAnchor = document.createElement('a');

    date.innerText = (new Date(entry.timestamp)).toLocaleString();
    linkAnchor.innerText =
        `${window.location.origin}${window.location.pathname}?json_url=${entry.source_url}`;
    linkAnchor.href = linkAnchor.innerText;
    linkAnchor.style.display = 'block';
    link.append(linkAnchor);
    row.append(date, link);
    this.table.append(row);
  }
}

interface SaveEntry {
  dirty: boolean;
  state: any;
  history: string[];
}

interface SaveHistory {
  source_url: string;
  timestamp: number;
}

const recordHistory = (url: string) => {
  return <SaveHistory>{timestamp: (new Date()).valueOf(), source_url: url};
};

export const saverToggle = (active: boolean) => {
  const saver = document.getElementsByClassName('ng-saver');
  let saveBtn: HTMLButtonElement;
  if (saver && saver.length) {
    saveBtn = <HTMLButtonElement>saver[0];
    saveBtn.classList.toggle('busy', !active);
    saveBtn.disabled = !active;
  }
};

export const storageAccessible = () => {
  // Stolen from
  // https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API/Using_the_Web_Storage_API
  const type = 'localStorage';
  let storage;
  try {
    storage = window[type];
    let x = '__storage_test__';
    storage.setItem(x, x);
    storage.removeItem(x);
    return true;
  } catch (e) {
    const outOfSpace = e instanceof DOMException &&
        (
                           // everything except Firefox
                           e.code === 22 ||
                           // Firefox
                           e.code === 1014 ||
                           // test name field too, because code might not be present
                           // everything except Firefox
                           e.name === 'QuotaExceededError' ||
                           // Firefox
                           e.name === 'NS_ERROR_DOM_QUOTA_REACHED') &&
        // acknowledge QuotaExceededError only if there's something already stored
        (storage && storage.length !== 0);
    // outOfSpace is still accessible
    return outOfSpace;
  }
};

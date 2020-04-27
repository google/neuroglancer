import 'neuroglancer/preferences/user_preferences.css';

import {Overlay} from 'neuroglancer/overlay';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {Viewer} from 'neuroglancer/viewer';
import {NumberInputWidget} from 'neuroglancer/widget/number_input_widget';

class UserPreferences {
  renderMeshByDefault: TrackableBoolean;
  prefetchSliceViewChunks: TrackableBoolean;
  cursorOnMousedrag: TrackableBoolean;
  saveToAddressBar: TrackableBoolean;
  unshareWarning: TrackableBoolean;
  constructor() {
    // mesh rendering is enabled by default, unless user selects not to
    this.renderMeshByDefault = new TrackableBoolean(true, true, 'renderMeshByDefault');
    // prefetching disabled by default, as it uses a lot of additional memory/bandwidth
    this.prefetchSliceViewChunks = new TrackableBoolean(false, false, 'prefetchSliceViewChunks');
    this.cursorOnMousedrag = new TrackableBoolean(true, true, 'cursorOnMousedrag');
    this.saveToAddressBar = new TrackableBoolean(false, false, 'saveToAddressBar');
    this.unshareWarning = new TrackableBoolean(true, true, 'unshareWarning');

    this.renderMeshByDefault.restoreState({});
    this.prefetchSliceViewChunks.restoreState({});
    this.cursorOnMousedrag.restoreState({});
    this.saveToAddressBar.restoreState({});
    this.unshareWarning.restoreState({});

    this.renderMeshByDefault.changed.add(() => {
      location.reload(false);
    });
  }
}

let userPreferences = new UserPreferences();

export function getRenderMeshByDefault(): boolean {
  return userPreferences.renderMeshByDefault.value;
}

export function getPrefetchSliceViewChunks(): TrackableBoolean {
  return userPreferences.prefetchSliceViewChunks;
}

export function getCursorOnMousedrag(): TrackableBoolean {
  return userPreferences.cursorOnMousedrag;
}

export function getSaveToAddressBar(): TrackableBoolean {
  return userPreferences.saveToAddressBar;
}

export function getUnshareWarning(): TrackableBoolean {
  return userPreferences.unshareWarning;
}

export function dismissUnshareWarning() {
  userPreferences.unshareWarning.value = false;
}

export class UserPreferencesDialog extends Overlay {
  constructor(public viewer: Viewer) {
    super();

    let {content} = this;
    content.classList.add('user-preferences');

    let scroll = document.createElement('div');
    scroll.classList.add('user-preferences-container');

    content.appendChild(scroll);

    let header = document.createElement('h3');
    header.textContent = 'Preferences';
    scroll.appendChild(header);

    const addLimitWidget = (label: string, limit: TrackableValue<number>) => {
      const widget = this.registerDisposer(new NumberInputWidget(limit, {label}));
      widget.element.classList.add('user-preferences-limit-widget');
      scroll.appendChild(widget.element);
      scroll.appendChild(document.createElement('br'));
    };
    addLimitWidget('GPU memory limit', viewer.chunkQueueManager.capacities.gpuMemory.sizeLimit);
    addLimitWidget(
        'System memory limit', viewer.chunkQueueManager.capacities.systemMemory.sizeLimit);
    addLimitWidget(
        'Concurrent chunk requests', viewer.chunkQueueManager.capacities.download.itemLimit);

    const addCheckbox =
        (label: string, value: TrackableBoolean, onclick?: (ev: MouseEvent) => any,
         title?: string) => {
          const labelElement = document.createElement('label');
          labelElement.textContent = label;
          const checkbox = this.registerDisposer(new TrackableBooleanCheckbox(value));
          if (onclick) {
            checkbox.element.onclick = onclick;
          }
          if (title) {
            labelElement.title = title;
          }
          labelElement.appendChild(checkbox.element);
          scroll.appendChild(labelElement);
        };

    addCheckbox('Render Mesh By Default', userPreferences.renderMeshByDefault);
    addCheckbox('Prefetch SliceView Chunks', userPreferences.prefetchSliceViewChunks);
    addCheckbox('Show cursor on mouse drag', userPreferences.cursorOnMousedrag);
    addCheckbox(
        'Old Style Saving', userPreferences.saveToAddressBar, () => location.reload(),
        `Saves state in address bar. Useful if storage is unsupported. Press save to post to JSON Server. Warning: Toggling the option reloads the page!`);
    addCheckbox(
        'Unshared state warning', userPreferences.unshareWarning, undefined,
        'Disable the warning message when loading an unshared state.');

    const evictButton = document.createElement('button');
    evictButton.innerText = '⚠️ Clear Storage';
    evictButton.title = 'Remove all local storage entries.';
    evictButton.addEventListener('click', () => {
      if (confirm(
              'All unshared or unopened states will be lost and you will need to reauthenticate. The page will be reloaded. Continue?')) {
        if (viewer.saver) {
          viewer.saver.userRemoveEntries(true);
          location.reload();
        }
      }
    });
    scroll.appendChild(evictButton);
  }
}

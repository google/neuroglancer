import flatpickr from 'flatpickr';
import minMaxTimePlugin from 'flatpickr/dist/plugins/minMaxTimePlugin';
import {SegmentationUserLayerWithGraphDisplayState} from 'neuroglancer/segmentation_user_layer_with_graph';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';

import 'flatpickr/dist/flatpickr.min.css';

export class TimeSegmentWidget extends RefCounted {
  element = document.createElement('div');
  input = <HTMLInputElement>document.createElement('input');
  limit: TrackableValue<string>;
  model: TrackableValue<string>;

  constructor(
      private displayState: SegmentationUserLayerWithGraphDisplayState,
      private undo?: (message: string, action: string) => void) {
    super();
    this.model = displayState.timestamp;
    this.limit = displayState.timestampLimit;
    const {element, input, model} = this;
    const cancelButton = document.createElement('button');
    const nothingButton = document.createElement('button');
    nothingButton.textContent = '✔️';
    nothingButton.title =
        `Actually, this button doesn't do anything at all. Click anywhere to close the time select.`;
    element.classList.add('neuroglancer-time-widget');
    input.type = 'datetime-local';
    const maybeInitial = this.dateFormat(model.value);
    this.buildFlatpickr(input, (maybeInitial !== '') ? `${maybeInitial}Z` : void (0));
    this.limit.changed.add(() => this.buildFlatpickr(input, input.value));
    cancelButton.textContent = '❌';
    cancelButton.title = 'Reset Time';
    cancelButton.addEventListener('click', () => {
      this.revert(true);
      this.model.value = '';
    });
    element.appendChild(input);
    element.appendChild(nothingButton);
    element.appendChild(cancelButton);
    input.addEventListener('change', () => this.updateModel());
    this.registerDisposer(model.changed.add(() => this.updateView()));
  }
  private dateFormat(value: string) {
    if (value === '') {
      return '';
    }
    return ((new Date(parseInt(value, 10) * 1000)).toISOString()).slice(0, -1);
  }
  private revert(reset?: boolean) {
    if (this.undo) {
      this.undo(
          `${reset ? 'Resetting' : 'Enabling'} Timestamp deselects selected segments.`, 'Undo?');
    }
  }

  private updateView() {
    const formatted = this.dateFormat(this.model.value);
    const inputFormatted = new Date(this.input.value).toISOString().slice(0, -1);
    if (formatted !== inputFormatted || this.input.value === '') {
      this.input.value = this.dateFormat(this.model.value);
      this.updateModel(true);
    }
  }
  private clearSeg() {
    this.displayState.rootSegments.clear();
    this.displayState.hiddenRootSegments!.clear();
  }
  private updateModel(view?: boolean) {
    if (!view) {
      this.revert();
      this.clearSeg();
      this.model.restoreState(this.input.value);
    } else {
      this.clearSeg();
    }
  }

  private buildFlatpickr(ele: HTMLInputElement, defaultDate?: string|Date) {
    return flatpickr(ele, {
      defaultDate,
      enableTime: true,
      enableSeconds: true,
      'disable': [(date) => {
        const target = date.valueOf();
        const future = Date.now();
        // note: this is fine b/c we are dealing with epoch time (date sheNaNigans are irrelevant
        // here)
        const past = parseInt(this.limit.value || '0', 10) - (24 * 60 * 60 * 1000);

        if (past) {
          return past > target || target >= future;
        } else {
          return target >= future;
        }
      }],
      plugins: [minMaxTimePlugin({
        getTimeLimits: (date) => {
          const now = new Date();
          const past = new Date(parseInt(this.limit.value || '0', 10));
          let minmax = {minTime: `00:00:00`, maxTime: `23:59:59`};

          if (date.toDateString() === now.toDateString()) {
            minmax.maxTime = `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;
          } else if (date.toDateString() === past.toDateString()) {
            // Flatpickr does not support millisecond res, must round up to nearest second
            // TODO: Seconds fixed has been merged in, remove + 1 to minutes when flatpickr is
            // updated
            minmax.minTime = `${past.getHours()}:${(past.getMinutes() + 1) % 60}:${
                (past.getSeconds() + 1) % 60}`;
          }
          return minmax;
        }
      })]
    });
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}

/**
 * @license
 * Copyright 2018 Google Inc.
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

/**
 * @file Support for editing Neuroglancer state as JSON directly within browser.
 */

import 'codemirror/lib/codemirror.css';
import 'codemirror/mode/javascript/javascript';
import 'codemirror/addon/fold/foldcode';
import 'codemirror/addon/fold/foldgutter';
import 'codemirror/addon/fold/brace-fold';
import 'codemirror/addon/fold/foldgutter.css';
import 'codemirror/addon/lint/lint.css';
import './state_editor.css';

import CodeMirror from 'codemirror';
import debounce from 'lodash/debounce';
import {Overlay} from 'neuroglancer/overlay';
import {getCachedJson} from 'neuroglancer/util/trackable';
import {Viewer} from 'neuroglancer/viewer';

const valueUpdateDelay = 100;

export class StateEditorDialog extends Overlay {
  textEditor: CodeMirror.Editor;
  applyButton: HTMLButtonElement;
  downloadButton: HTMLButtonElement;
  closeButton: HTMLButtonElement;
  constructor(public viewer: Viewer) {
    super();

    this.content.classList.add('neuroglancer-state-editor');

    const buttonApply = this.applyButton = document.createElement('button');
    buttonApply.textContent = 'Apply changes';
    this.content.appendChild(buttonApply);
    buttonApply.addEventListener('click', () => this.applyChanges());
    buttonApply.disabled = true;

    const buttonClose = this.closeButton = document.createElement('button');
    buttonClose.classList.add('close-button');
    buttonClose.textContent = 'Close';
    this.content.appendChild(buttonClose);
    buttonClose.addEventListener('click', () => this.dispose());

    const downloadButton = this.downloadButton = document.createElement('button');
    downloadButton.textContent = 'Download';
    downloadButton.title = 'Download state as a JSON file'
    this.content.appendChild(downloadButton);
    downloadButton.addEventListener('click', () => this.downloadState());

    this.textEditor = CodeMirror(_element => {}, <any>{
      value: '',
      mode: {'name': 'javascript', json: true},
      foldGutter: true,
      gutters: [
        'CodeMirror-lint-markers',
        'CodeMirror-foldgutter',
      ],
    });
    this.updateView();

    this.textEditor.on('change', () => {
      this.debouncedValueUpdater();
    });

    this.content.appendChild(this.textEditor.getWrapperElement());
    this.textEditor.refresh();
  }

  private downloadState() {
    const downloadLink = document.createElement('a');
    const blob = new Blob([this.getJson()], {type: 'text/json'});
    const blobUrl = URL.createObjectURL(blob);
    downloadLink.href = blobUrl;
    downloadLink.download = 'state.json';
    downloadLink.click();
    document.body.removeChild(downloadLink);
  }

  private applyChanges() {
    if (this.parsedValue !== null) {
      this.viewer.state.reset();
      this.viewer.state.restoreState(this.parsedValue);
    }
    this.applyButton.disabled = true;
  }

  private updateView() {
    this.textEditor.setValue(this.getJson());
    (<any>this.textEditor).execCommand('foldAll');
    (<any>this.textEditor).execCommand('unfold');
  }

  parsedValue: any = null;

  debouncedValueUpdater = debounce(() => {
    const value = this.textEditor.getValue();
    try {
      const json = JSON.parse(value);
      this.parsedValue = json;
      this.applyButton.disabled = false;
      this.textEditor.setOption('lint', undefined);
    } catch (parseError) {
      this.parsedValue = null;
      this.applyButton.disabled = true;
      let line = 0, column = 0, message = 'Unknown parse error';
      if (parseError instanceof Error) {
        const m = parseError.message.match(/^((?:.|\n)*) in JSON at position ([0-9]+)$/);
        if (m !== null) {
          message = m[1];
          const offset = parseInt(m[2], 10);
          const prefix = value.substring(0, offset);
          const lines = prefix.split('\n');
          line = lines.length - 1;
          column = lines[lines.length - 1].length;
        } else {
          message = parseError.message;
        }
      }
      this.textEditor.setOption('lint', {
        getAnnotations: () => {
          return [{
            message,
            severity: 'error',
            from: CodeMirror.Pos(line, column),
          }];
        },
      });
    }
  }, valueUpdateDelay);

  getJson() {
    return JSON.stringify(getCachedJson(this.viewer.state).value, null, '  ');
  }
}

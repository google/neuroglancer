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

import 'codemirror/addon/lint/lint.js';

import CodeMirror from 'codemirror';
import debounce from 'lodash/debounce';
import {WatchableValue} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {WatchableShaderError} from 'neuroglancer/webgl/dynamic_shader';
import {ShaderCompilationError, ShaderLinkError} from 'neuroglancer/webgl/shader';

require('./shader_code_widget.css');
require('codemirror/lib/codemirror.css');
require('codemirror/addon/lint/lint.css');
require<(codeMirror: typeof CodeMirror) => void>('glsl-editor/glsl')(CodeMirror);

/**
 * Time in milliseconds during which the input field must not be modified before the shader is
 * recompiled.
 */
const SHADER_UPDATE_DELAY = 500;

interface ShaderCodeState {
  shaderError: WatchableShaderError;
  fragmentMain: WatchableValue<string>;
  fragmentMainStartLine: string;
}

export class ShaderCodeWidget extends RefCounted {
  textEditor: CodeMirror.Editor;
  get element() { return this.textEditor.getWrapperElement(); }
  private changingValue = false;
  private debouncedValueUpdater = debounce(() => {
    this.changingValue = true;
    try {
      this.state.fragmentMain.value = this.textEditor.getValue();
    } finally {
      this.changingValue = false;
    }
  }, SHADER_UPDATE_DELAY);

  constructor(public state: ShaderCodeState) {
    super();
    this.textEditor = CodeMirror(_element => {}, {
      value: this.state.fragmentMain.value,
      mode: 'glsl',
      gutters: ['CodeMirror-lint-markers'],
    });
    this.textEditor.on('change', () => {
      this.setValidState(undefined);
      this.debouncedValueUpdater();
    });
    this.registerDisposer(this.state.fragmentMain.changed.add(() => {
      if (!this.changingValue) {
        this.textEditor.setValue(this.state.fragmentMain.value);
      }
    }));
    this.element.classList.add('neuroglancer-shader-code-widget');
    this.registerDisposer(
        this.state.shaderError.changed.add(() => { this.updateErrorState(); }));
    this.updateErrorState();
  }

  updateErrorState() {
    const error = this.state.shaderError.value;
    if (error === undefined) {
      this.setValidState(undefined);
    } else if (error !== null) {
      this.textEditor.setOption('lint', {
        getAnnotations: () => {
          if (error.name === 'ShaderCompilationError') {
            let fragmentMainStartLineNumber = (<ShaderCompilationError>error)
                                                  .source.split('\n')
                                                  .indexOf(this.state.fragmentMainStartLine) +
                2;
            return (<ShaderCompilationError>error).errorMessages.map(e => {
              return {
                message: e.message,
                severity: 'error',
                from:
                    CodeMirror.Pos(e.line === undefined ? 0 : e.line - fragmentMainStartLineNumber),
              };
            });
          } else if (error!.name === 'ShaderLinkError') {
            return [{
              message: (<ShaderLinkError>error).log,
              severity: 'error',
              from: CodeMirror.Pos(0),
            }];
          } else {
            return [{
              message: error!.message,
              severity: 'error',
              from: CodeMirror.Pos(0),
            }];
          }
        },
      });
      this.setValidState(false);
    } else {
      this.textEditor.setOption('lint', undefined);
      this.setValidState(true);
    }
  }

  setValidState(valid?: boolean) {
    let {element} = this;
    element.classList.remove('invalid-input');
    element.classList.remove('valid-input');
    if (valid === true) {
      element.classList.add('valid-input');
    } else if (valid === false) {
      element.classList.add('invalid-input');
    }
  }

  disposed() {
    (<{flush?: () => void}>this.debouncedValueUpdater).flush!();
    this.debouncedValueUpdater = <any>undefined;
    removeFromParent(this.element);
    this.textEditor = <any>undefined;
    super.disposed();
  }
}

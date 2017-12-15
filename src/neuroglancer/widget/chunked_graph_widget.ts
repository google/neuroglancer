/**
 * @license
 * Copyright 2017 The Neuroglancer Authors
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

import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';

require('neuroglancer/noselect.css');
require('./chunked_graph_widget.css');

interface ChunkedGraphState {
  url: string;
}

export class ChunkedGraphWidget extends RefCounted {
  element = document.createElement('div');
  label = document.createElement('span');
  graph = document.createElement('div');
  url = document.createElement('a');
  status = document.createElement('div');

  constructor(public state: ChunkedGraphState) {
    super();
    let {element, label, graph, url, status} = this;
    element.className = 'neuroglancer-chunked-graph-widget';
    element.appendChild(label);
    element.appendChild(graph);
    graph.className = 'graph-wrapper';
    graph.appendChild(url);
    graph.appendChild(status);
    label.className = 'neuroglancer-noselect';
    label.appendChild(document.createTextNode('Graph Server:'));
    url.innerText = state.url;
    url.setAttribute('href', state.url);
    url.setAttribute('target', '_blank');
    status.className = 'neuroglancer-chunked-graph-widget graph-state waiting';
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}

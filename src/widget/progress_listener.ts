/**
 * @license
 * Copyright 2024 Google Inc.
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

import type {
  ProgressListener,
  ProgressSpan,
  ProgressSpanId,
} from "#src/util/progress_listener.js";
import { ProgressSpanSet } from "#src/util/progress_listener.js";

export class ProgressListenerWidget implements ProgressListener {
  element = document.createElement("ul");
  constructor() {
    this.element.classList.add("neuroglancer-progress");
  }
  private spanElements = new Map<number, HTMLElement>();
  private spans = new ProgressSpanSet();

  addSpan(span: ProgressSpan) {
    if (this.spans.add(span) !== 1) return;
    const spanElement = document.createElement("li");
    spanElement.textContent = span.message;
    this.spanElements.set(span.id, spanElement);
    this.element.appendChild(spanElement);
  }

  removeSpan(spanId: ProgressSpanId) {
    if (this.spans.deleteKey(spanId) !== 0) return;
    const { spanElements } = this;
    const spanElement = spanElements.get(spanId)!;
    spanElements.delete(spanId);
    this.element.removeChild(spanElement);
  }
}

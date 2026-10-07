/**
 * @license
 * Copyright 2026 Google Inc.
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

import type { UserLayer } from "#src/layer/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import type {
  AvailableSegmentProperties,
  SegmentPropertyReference,
} from "#src/webgl/shader_ui_controls.js";
import type { LayerControlFactory } from "#src/widget/layer_control.js";

type SegmentPropertyOption = SegmentPropertyReference & {
  dataType?: DataType;
};

function encodeSegmentPropertyReference(ref: SegmentPropertyReference) {
  return JSON.stringify([ref.type, ref.id]);
}

function decodeSegmentPropertyReference(
  value: string,
): SegmentPropertyReference | undefined {
  try {
    const [type, id] = JSON.parse(value) as unknown[];
    if (
      (type === "tag" || type === "numerical" || type === "string") &&
      typeof id === "string"
    ) {
      return { type, id };
    }
  } catch {
    // Fall through to undefined.
  }
  return undefined;
}

function segmentPropertyReferencesEqual(
  a: SegmentPropertyReference | undefined,
  b: SegmentPropertyReference | undefined,
) {
  return a?.type === b?.type && a?.id === b?.id;
}

export class SegmentPropertySelectWidget extends RefCounted {
  element = document.createElement("select");

  constructor(
    segmentProperties: AvailableSegmentProperties,
    public model: WatchableValueInterface<SegmentPropertyReference | undefined>,
  ) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-select-widget");

    const maybeAddGroup = (label: string, values: SegmentPropertyOption[]) => {
      if (values.length) {
        const optGroup = document.createElement("optgroup");
        optGroup.label = `${label} properties`;
        element.appendChild(optGroup);
        for (const value of values) {
          const option = document.createElement("option");
          option.value = encodeSegmentPropertyReference(value);
          option.textContent =
            value.dataType === undefined
              ? value.id
              : `${value.id} (${DataType[value.dataType].toLowerCase()})`;
          optGroup.appendChild(option);
        }
      }
    };

    maybeAddGroup(
      "tag",
      segmentProperties.tags.map((id) => ({ type: "tag", id })),
    );
    maybeAddGroup(
      "numerical",
      [...segmentProperties.numericalProperties].map(([id, dataType]) => ({
        type: "numerical",
        id,
        dataType,
      })),
    );
    maybeAddGroup(
      "string",
      segmentProperties.stringProperties.map((id) => ({ type: "string", id })),
    );

    this.registerDisposer(model.changed.add(() => this.updateView()));
    this.registerEventListener(element, "change", () => this.updateModel());
    this.updateView();
  }

  private updateView() {
    if (this.model.value === undefined) {
      this.element.selectedIndex = -1;
      return;
    }
    this.element.value = encodeSegmentPropertyReference(this.model.value);
  }

  private updateModel() {
    const value = decodeSegmentPropertyReference(this.element.value);
    if (!segmentPropertyReferencesEqual(value, this.model.value)) {
      this.model.value = value;
    }
  }
}

export function propertyLayerControl<LayerType extends UserLayer>(
  getter: (layer: LayerType) => {
    segmentProperties: AvailableSegmentProperties;
    watchableValue: WatchableValueInterface<
      SegmentPropertyReference | undefined
    >;
  },
): LayerControlFactory<LayerType, SegmentPropertySelectWidget> {
  return {
    makeControl: (layer, context) => {
      const { segmentProperties, watchableValue } = getter(layer);
      const control = context.registerDisposer(
        new SegmentPropertySelectWidget(segmentProperties, watchableValue),
      );
      return { control, controlElement: control.element };
    },
    activateTool: () => {},
  };
}

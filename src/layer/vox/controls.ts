import type { UserLayerConstructor } from "#src/layer/index.js";
import { LayerActionContext } from "#src/layer/index.js";
import type { UserLayerWithVoxelEditing } from "#src/layer/vox/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import { observeWatchable } from "#src/trackable_value.js";
import { unpackRGB } from "#src/util/color.js";
import { RefCounted } from "#src/util/disposable.js";
import { vec3 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";
import type { LayerControlDefinition } from "#src/widget/layer_control.js";
import { registerLayerControl } from "#src/widget/layer_control.js";
import { buttonLayerControl } from "#src/widget/layer_control_button.js";
import { checkboxLayerControl } from "#src/widget/layer_control_checkbox.js";
import { colorLayerControl } from "#src/widget/layer_control_color.js";
import { enumLayerControl } from "#src/widget/layer_control_enum.js";
import { rangeLayerControl } from "#src/widget/layer_control_range.js";

class BigIntAsTrackableRGB extends RefCounted implements WatchableValueInterface<vec3> {
  changed = new NullarySignal();
  private tempColor = vec3.create();

  constructor(public source: WatchableValueInterface<bigint>) {
    super();
    this.registerDisposer(source.changed.add(this.changed.dispatch));
  }

  get value(): vec3 {
    const bigintValue = this.source.value;
    const [r, g, b] = unpackRGB(Number(bigintValue & 0xffffffn));
    vec3.set(this.tempColor, r, g, b);
    return this.tempColor;
  }

  set value(newValue: vec3) {
    const rgb = newValue.map((c: number) => Math.round(c * 255));
    this.source.value = BigInt((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]);
  }
}

export const VOXEL_LAYER_CONTROLS: LayerControlDefinition<UserLayerWithVoxelEditing>[] =
  [
    {
      label: "Brush size",
      toolJson: { type: "vox-brush-size" },
      ...rangeLayerControl((layer) => ({
        value: layer.voxBrushRadius,
        options: { min: 1, max: 64, step: 1 },
      })),
    },
    {
      label: "Eraser",
      toolJson: { type: "vox-erase-mode" },
      ...checkboxLayerControl((layer) => layer.voxEraseMode),
    },
    {
      label: "Brush shape",
      toolJson: { type: "vox-brush-shape" },
      ...enumLayerControl(
        (layer: UserLayerWithVoxelEditing) => layer.voxBrushShape,
      ),
    },
    {
      label: "Max fill voxels",
      toolJson: { type: "vox-flood-max-voxels" },
      ...rangeLayerControl((layer) => ({
        value: layer.voxFloodMaxVoxels,
        options: { min: 1, max: 1000000, step: 1000 },
      })),
    },
    {
      label: "Undo",
      toolJson: { type: "vox-undo" },
      ...buttonLayerControl({
        text: "Undo",
        onClick: (layer) =>
          layer.handleVoxAction("undo", new LayerActionContext()),
      }),
    },
    {
      label: "Redo",
      toolJson: { type: "vox-redo" },
      ...buttonLayerControl({
        text: "Redo",
        onClick: (layer) =>
          layer.handleVoxAction("redo", new LayerActionContext()),
      }),
    },
    {
      label: "Paint Color",
      toolJson: { type: "vox-paint-color" },
      ...colorLayerControl((layer: UserLayerWithVoxelEditing) => new BigIntAsTrackableRGB(layer.paintValue)),
    },
    {
      label: "Paint Value",
      toolJson: { type: "vox-paint-value" },
      makeControl: (layer, context) => {
        const control = document.createElement("input");
        control.type = "text";
        control.title = "Specify segment ID or intensity value to paint";
        control.addEventListener("change", () => {
          try {
            layer.setVoxelPaintValue(BigInt(control.value));
          } catch {
            control.value = layer.paintValue.value.toString();
          }
        });
        context.registerDisposer(
          observeWatchable((value) => {
            control.value = value.toString();
          }, layer.paintValue),
        );
        control.value = layer.paintValue.value.toString();
        return { control, controlElement: control, parent: context };
      },
      activateTool: () => {},
    },
    {
      label: "New Random Value",
      toolJson: { type: "vox-random-value" },
      ...buttonLayerControl({
        text: "Random",
        onClick: (layer) =>
          layer.handleVoxAction("randomize-paint-value", new LayerActionContext()),
      }),
    },
  ];

export function registerVoxelLayerControls(
  layerType: UserLayerConstructor<UserLayerWithVoxelEditing>,
) {
  for (const control of VOXEL_LAYER_CONTROLS) {
    registerLayerControl(layerType, control);
  }
}

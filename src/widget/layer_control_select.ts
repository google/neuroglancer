import type { UserLayer } from "#src/layer/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { LayerControlFactory } from "#src/widget/layer_control.js";

export function selectLayerControl<LayerType extends UserLayer>(
  getter: (layer: LayerType) => {
    value: WatchableValueInterface<string>;
    options: string[];
  },
): LayerControlFactory<LayerType, HTMLSelectElement> {
  return {
    makeControl: (layer, context) => {
      const { value, options } = getter(layer);
      const select = document.createElement("select");
      for (const label of options) {
        const opt = document.createElement("option");
        opt.value = label;
        opt.textContent = label;
        select.appendChild(opt);
      }
      select.value = value.value;
      context.registerDisposer(
        value.changed.add(() => {
          select.value = value.value;
        }),
      );
      select.addEventListener("change", () => {
        value.value = select.value;
      });
      return { control: select, controlElement: select };
    },
    activateTool: (_activation, _control) => {},
  };
}

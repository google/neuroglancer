import type { UserLayer } from "#src/layer/index.js";
import type { WatchableValueInterface } from "#src/trackable_value.js";
import type { LayerControlFactory } from "#src/widget/layer_control.js";

export function dropdownLayerControl<LayerType extends UserLayer>(
  getter: (layer: LayerType) => {
    value: WatchableValueInterface<number>;
    options: string[];
  },
): LayerControlFactory<LayerType, HTMLSelectElement> {
  return {
    makeControl: (layer, context) => {
      const { value, options } = getter(layer);
      const select = document.createElement("select");
      for (const [i, label] of options.entries()) {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = label;
        select.appendChild(opt);
      }
      select.value = String(value.value);
      context.registerDisposer(
        value.changed.add(() => {
          select.value = String(value.value);
        }),
      );
      select.addEventListener("change", () => {
        value.value = parseInt(select.value, 10);
      });
      return { control: select, controlElement: select };
    },
    activateTool: (_activation, _control) => {},
  };
}

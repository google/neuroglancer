import {bindDefaultCopyHandler, bindDefaultPasteHandler} from 'neuroglancer/ui/default_clipboard_handling';
import {setDefaultInputEventBindings} from 'neuroglancer/ui/default_input_event_bindings';
import {makeMinimalViewer} from 'neuroglancer/ui/minimal_viewer';
import { registerPositionWidgetTool } from './neuroglancer/widget/registerPositionWidgetTools';
export {makeLayer} from "neuroglancer/layer"
import {disableContextMenu, disableWheel} from 'neuroglancer/ui/disable_default_actions';
export {insertDimensionAt} from "neuroglancer/coordinate_transform"
export {DEFAULT_FRAGMENT_MAIN} from "neuroglancer/sliceview/volume/image_renderlayer"

import "neuroglancer/datasource/precomputed/register_default"
import "neuroglancer/datasource/zarr/register_default"
import "neuroglancer/image_user_layer";
import "neuroglancer/annotation/user_layer"

export default class Neuroglancer {
  version() {
    return '0.0.1';
  }
}


export const hedwigSetup = (options: {
  target: HTMLElement | undefined,
  bundleRoot: string | undefined,
  chunkWorkerFileName: string,
  hedwigHideZScaleBar: boolean 
}) => {

  registerPositionWidgetTool()

  disableContextMenu();
  disableWheel();
  let viewer = makeMinimalViewer({
    chunkWorkerFileName: options.chunkWorkerFileName,
    hedwigHideZScaleBar: options.hedwigHideZScaleBar,
  }, options.target);
  setDefaultInputEventBindings(viewer.inputEventBindings);
  bindDefaultCopyHandler(viewer);
  bindDefaultPasteHandler(viewer);
  return viewer;
}

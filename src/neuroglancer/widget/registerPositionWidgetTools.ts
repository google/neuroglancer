import { DIMENSION_TOOL_ID, makeDimensionTool } from "./position_widget";
import { registerTool } from "../ui/tool";
import {UserLayer} from 'neuroglancer/layer';
import {LayerGroupViewer} from 'neuroglancer/layer_group_viewer';
import {Viewer} from 'neuroglancer/viewer';

export const registerPositionWidgetTool = () => {
  registerTool(
      Viewer, DIMENSION_TOOL_ID,
      (viewer, obj) => makeDimensionTool(
          {
            position: viewer.position,
            velocity: viewer.velocity,
            coordinateSpaceCombiner: viewer.layerSpecification.coordinateSpaceCombiner,
            toolBinder: viewer.toolBinder,
          },
          obj));

  registerTool(
      UserLayer, DIMENSION_TOOL_ID,
      (layer, obj) => makeDimensionTool(
          {
            position: layer.localPosition,
            velocity: layer.localVelocity,
            coordinateSpaceCombiner: layer.localCoordinateSpaceCombiner,
            toolBinder: layer.toolBinder,
          },
          obj));

  registerTool(
      LayerGroupViewer, DIMENSION_TOOL_ID,
      (layerGroupViewer, obj) => makeDimensionTool(
          {
            position: layerGroupViewer.viewerNavigationState.position.value,
            velocity: layerGroupViewer.viewerNavigationState.velocity.velocity,
            coordinateSpaceCombiner: layerGroupViewer.layerSpecification.root.coordinateSpaceCombiner,
            toolBinder: layerGroupViewer.toolBinder,
          },
          obj));
}


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

/**
 * @file Implements the Find Path tool, which picks two nodes of one skeleton
 * and finds the path between them in its cached nodes.
 */

import type { Annotation } from "#src/annotation/index.js";
import type { SegmentationUserLayer } from "#src/layer/segmentation/index.js";
import { SpatialSkeletonActions } from "#src/skeleton/edit_commands.js";
import type { SkeletonFindPathEndpoint } from "#src/skeleton/find_path/find_path.js";
import {
  SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION,
  SPATIAL_SKELETON_FIND_PATH_TARGET_DESCRIPTION,
} from "#src/skeleton/find_path/find_path_annotations.js";
import {
  getPathBetweenNodes,
  type SkeletonNavigationGraph,
} from "#src/skeleton/navigation_graph.js";
import { isSkeletonNodeTrueEnd } from "#src/skeleton/node_attributes.js";
import {
  classifySkeletonDisplayNodeType,
  SkeletonDisplayNodeType,
} from "#src/skeleton/node_types.js";
import { StatusMessage } from "#src/status.js";
import { makeAnnotationListElement } from "#src/ui/annotations.js";
import { getDefaultAnnotationListBindings } from "#src/ui/default_input_event_bindings.js";
import {
  SKELETON_FIND_PATH_SELECT_ENDPOINT,
  SKELETON_FIND_PATH_TOOL_INPUT_EVENT_MAP,
} from "#src/ui/skeleton_edit_tool_shortcuts.js";
import {
  bindSpatialSkeletonViewDrag,
  makeSpatialSkeletonToolLister,
  SPATIAL_SKELETON_FIND_PATH_TOOL_ID,
  SpatialSkeletonToolBase,
} from "#src/ui/skeleton_tool_base.js";
import type { ToolActivation } from "#src/ui/tool.js";
import {
  makeToolActivationStatusMessageWithHeader,
  registerTool,
} from "#src/ui/tool.js";
import { removeChildren } from "#src/util/dom.js";
import type { ActionEvent } from "#src/util/event_action_map.js";
import { MouseEventBinder } from "#src/util/mouse_bindings.js";
import { makeIcon } from "#src/widget/icon.js";

function getSpatialSkeletonFindPathNodeTypeLabel(
  graph: SkeletonNavigationGraph,
  nodeId: bigint,
) {
  const node = graph.nodeById.get(nodeId);
  if (node === undefined) return undefined;
  if (isSkeletonNodeTrueEnd(node)) return "True end";
  const parentInTree =
    node.parentNodeId !== undefined && graph.nodeById.has(node.parentNodeId);
  const type = classifySkeletonDisplayNodeType(
    node,
    graph.childrenByParent.get(nodeId)?.length ?? 0,
    parentInTree,
  );
  switch (type) {
    case SkeletonDisplayNodeType.ROOT:
      return "Root";
    case SkeletonDisplayNodeType.BRANCH_START:
      return "Branch point";
    case SkeletonDisplayNodeType.VIRTUAL_END:
      return "Leaf";
    default:
      return "Node";
  }
}

export function getSpatialSkeletonFindPathEndpointDescription(
  endpointName: "Source" | "Target",
  endpoint: SkeletonFindPathEndpoint,
  graph: SkeletonNavigationGraph | undefined,
) {
  const nodeType =
    graph === undefined
      ? undefined
      : getSpatialSkeletonFindPathNodeTypeLabel(graph, endpoint.nodeId);
  return nodeType === undefined
    ? endpointName
    : `${endpointName} · ${nodeType}`;
}

export class SpatialSkeletonFindPathTool extends SpatialSkeletonToolBase {
  toJSON() {
    return SPATIAL_SKELETON_FIND_PATH_TOOL_ID;
  }

  get description() {
    return "Find path";
  }

  activate(activation: ToolActivation<this>) {
    if (
      !this.cancelActivationIfPreconditionsFail(
        activation,
        SpatialSkeletonActions.inspect,
      )
    ) {
      return;
    }

    const { layer } = this;
    const activeContext = layer.skeletonSourceConnection.getFindPathContext();

    const { body, header } = makeToolActivationStatusMessageWithHeader(
      activation,
      { showBindings: false },
    );
    header.textContent = "Find Path";
    body.classList.add("neuroglancer-skeleton-find-path-status");

    const statusElement = document.createElement("span");
    statusElement.className = "neuroglancer-skeleton-find-path-message";
    let statusOverride: string | undefined;

    const getStateContext = () => {
      if (activeContext === undefined) return undefined;
      return layer.skeletonSourceConnection.getFindPathContext() ===
        activeContext
        ? activeContext
        : undefined;
    };

    const getState = () => getStateContext()?.state;
    body.appendChild(
      makeIcon({
        text: "Clear",
        title: "Clear Find Path",
        onClick: () => {
          statusOverride = undefined;
          getState()?.clear();
        },
      }),
    );
    body.appendChild(statusElement);

    const annotationElements = document.createElement("div");
    annotationElements.className =
      "neuroglancer-skeleton-find-path-annotations";
    body.appendChild(annotationElements);
    annotationElements.addEventListener("mouseleave", () => {
      layer.annotationDisplayState.hoverState.value = undefined;
    });
    activation.registerDisposer(
      new MouseEventBinder(
        annotationElements,
        getDefaultAnnotationListBindings(),
      ),
    );

    const updateAnnotationElements = () => {
      removeChildren(annotationElements);
      const state = getState();
      const annotationState =
        getStateContext()?.annotationController.annotationState;
      if (state === undefined || annotationState === undefined) return;
      const annotationsByDescription = new Map<string, Annotation>();
      for (const annotation of annotationState.source) {
        if (
          annotation.description ===
            SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION ||
          annotation.description ===
            SPATIAL_SKELETON_FIND_PATH_TARGET_DESCRIPTION
        ) {
          annotationsByDescription.set(annotation.description, annotation);
        }
      }
      const maxColumnWidths = [0, 0, 0];
      const template =
        "[symbol] 2ch [dim] var(--neuroglancer-column-0-width) [dim] var(--neuroglancer-column-1-width) [dim] var(--neuroglancer-column-2-width) [delete] min-content";
      for (const description of [
        SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION,
        SPATIAL_SKELETON_FIND_PATH_TARGET_DESCRIPTION,
      ]) {
        const annotation = annotationsByDescription.get(description);
        if (annotation === undefined) continue;
        const sourceEndpoint =
          description === SPATIAL_SKELETON_FIND_PATH_SOURCE_DESCRIPTION;
        const endpoint = sourceEndpoint ? state.source : state.target;
        const [element, elementColumnWidths] = makeAnnotationListElement(
          layer,
          annotation,
          annotationState,
          template,
          [0, 1, 2],
          [],
        );
        if (endpoint !== undefined) {
          const graph = layer.skeletonNodeSelection.navigator.getGraph(
            endpoint.segmentId,
          );
          const endpointDescription =
            getSpatialSkeletonFindPathEndpointDescription(
              sourceEndpoint ? "Source" : "Target",
              endpoint,
              graph,
            );
          const descriptionElement = element.querySelector(
            ".neuroglancer-annotation-description",
          );
          if (descriptionElement !== null) {
            descriptionElement.textContent = endpointDescription;
          }
          element.title = `${endpointDescription} · node ${endpoint.nodeId}`;
        }
        for (const [column, width] of elementColumnWidths.entries()) {
          maxColumnWidths[column] = Math.max(maxColumnWidths[column], width);
        }
        annotationElements.appendChild(element);
      }
      for (const [column, width] of maxColumnWidths.entries()) {
        annotationElements.style.setProperty(
          `--neuroglancer-column-${column}-width`,
          `${width + 2}ch`,
        );
      }
    };

    function updateStatus() {
      const state = getState();
      if (statusOverride !== undefined) {
        statusElement.textContent = statusOverride;
      } else if (state === undefined) {
        statusElement.textContent =
          "No spatial skeleton datasource supports Find Path.";
      } else if (state.result !== undefined) {
        statusElement.textContent = `Path found (${state.result.length} nodes).`;
      } else if (state.source === undefined) {
        statusElement.textContent = "Left-click the source node.";
      } else if (state.target === undefined) {
        statusElement.textContent = "Left-click the target node.";
      } else {
        statusElement.textContent = "Finding path…";
      }
      updateAnnotationElements();
    }

    const showPathStatus = (message: string, announce: boolean) => {
      statusOverride = message;
      updateStatus();
      if (announce) {
        StatusMessage.showTemporaryMessage(message);
      }
    };

    const computePath = (announce: boolean) => {
      const context = getStateContext();
      const state = context?.state;
      if (context === undefined || state === undefined) {
        showPathStatus(
          "The spatial skeleton source selected for Find Path is no longer loaded.",
          announce,
        );
        return false;
      }
      const { source, target } = state;
      if (source === undefined || target === undefined) {
        updateStatus();
        return false;
      }
      if (state.result !== undefined) {
        updateStatus();
        return true;
      }
      if (source.segmentId !== target.segmentId) {
        showPathStatus(
          "Find Path endpoints must belong to the same skeleton segment.",
          announce,
        );
        return false;
      }
      if (source.nodeId === target.nodeId) {
        showPathStatus(
          "Find Path endpoints must be distinct skeleton nodes.",
          announce,
        );
        return false;
      }

      const { segmentId } = source;
      const sourceNodeId = source.nodeId;
      const targetNodeId = target.nodeId;
      const graph = layer.skeletonNodeSelection.navigator.getGraph(segmentId);
      if (graph === undefined) {
        showPathStatus(
          `Full data for skeleton ${source.segmentId} is not cached. Make it visible and wait for loading.`,
          announce,
        );
        return false;
      }

      statusOverride = undefined;
      try {
        if (!graph.nodeById.has(sourceNodeId)) {
          throw new Error(
            `Source node ${source.nodeId} is missing from the loaded skeleton.`,
          );
        }
        if (!graph.nodeById.has(targetNodeId)) {
          throw new Error(
            `Target node ${target.nodeId} is missing from the loaded skeleton.`,
          );
        }
        const path = getPathBetweenNodes(graph, sourceNodeId, targetNodeId);
        if (path === undefined) {
          throw new Error(
            `No route exists between nodes ${source.nodeId} and ${target.nodeId}.`,
          );
        }
        state.setResult(
          path.map(({ nodeId, position }) => ({
            nodeId: nodeId,
            position: new Float32Array(position),
          })),
        );
        if (announce) {
          StatusMessage.showTemporaryMessage("Path found!", 5000);
        }
        return true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        showPathStatus(`Failed to find path: ${detail}`, announce);
        return false;
      }
    };

    const state = getState();
    if (state !== undefined) {
      activation.registerDisposer(
        state.changed.add(() => {
          statusOverride = undefined;
          updateStatus();
        }),
      );
    }
    activation.registerDisposer(
      layer.spatialSkeletonEditSession.nodeDataVersion.changed.add(() => {
        statusOverride = undefined;
        const state = getState();
        if (
          state?.source !== undefined &&
          state.target !== undefined &&
          state.result === undefined
        ) {
          computePath(false);
        } else {
          updateStatus();
        }
      }),
    );
    this.registerAutoCancelOnDisabled(
      activation,
      SpatialSkeletonActions.inspect,
      updateStatus,
    );

    bindSpatialSkeletonViewDrag(activation);
    activation.bindInputEventMap(SKELETON_FIND_PATH_TOOL_INPUT_EVENT_MAP);
    activation.bindAction(
      SKELETON_FIND_PATH_SELECT_ENDPOINT,
      (event: ActionEvent<MouseEvent>) => {
        event.stopPropagation();
        event.detail.preventDefault();
        const currentState = getState();
        if (
          currentState?.source !== undefined &&
          currentState.target !== undefined
        ) {
          StatusMessage.showTemporaryMessage(
            "Clear Find Path or delete an endpoint before selecting another node.",
          );
          return;
        }
        const skeletonLayer = this.getActiveSpatiallyIndexedSkeletonLayer();
        const context = getStateContext();
        if (skeletonLayer === undefined) {
          StatusMessage.showTemporaryMessage(
            "No spatially indexed skeleton source is currently loaded.",
          );
          return;
        }
        if (context === undefined) {
          StatusMessage.showTemporaryMessage(
            "The spatial skeleton source selected for Find Path is no longer loaded.",
          );
          return;
        }
        const pickedNode = this.resolvePickedNodeSelection(skeletonLayer);
        if (
          pickedNode?.segmentId === undefined ||
          pickedNode.position === undefined
        ) {
          StatusMessage.showTemporaryMessage(
            "Find Path endpoints must be exact skeleton nodes, not edges.",
          );
          return;
        }
        const endpoint: SkeletonFindPathEndpoint = {
          nodeId: pickedNode.nodeId,
          segmentId: pickedNode.segmentId,
          position: new Float32Array(pickedNode.position),
        };
        const { state } = context;
        const otherEndpoint =
          state.source === undefined ? state.target : state.source;
        if (otherEndpoint !== undefined) {
          if (otherEndpoint.segmentId !== endpoint.segmentId) {
            StatusMessage.showTemporaryMessage(
              "Find Path endpoints must belong to the same skeleton segment.",
            );
            return;
          }
          if (otherEndpoint.nodeId === endpoint.nodeId) {
            StatusMessage.showTemporaryMessage(
              "Find Path endpoints must be distinct skeleton nodes.",
            );
            return;
          }
        }
        statusOverride = undefined;
        if (state.source === undefined) {
          state.setSource(endpoint);
        } else {
          state.setTarget(endpoint);
        }
        if (state.source !== undefined && state.target !== undefined) {
          computePath(true);
        }
      },
    );

    if (
      state?.source !== undefined &&
      state.target !== undefined &&
      state.result === undefined
    ) {
      computePath(false);
    } else {
      updateStatus();
    }
  }
}

export function registerSpatialSkeletonFindPathTool(
  contextType: typeof SegmentationUserLayer,
) {
  registerTool(
    contextType,
    SPATIAL_SKELETON_FIND_PATH_TOOL_ID,
    (layer) => new SpatialSkeletonFindPathTool(layer),
    makeSpatialSkeletonToolLister(SPATIAL_SKELETON_FIND_PATH_TOOL_ID),
  );
}

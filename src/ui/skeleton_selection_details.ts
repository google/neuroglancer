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

import "#src/ui/skeleton_selection_details.css";

import { debounce } from "lodash-es";

import type {
  SegmentationLayerSelectionState,
  SegmentationUserLayer,
} from "#src/layer/segmentation/index.js";
import {
  getNodeIdFromLayerSelectionState,
  getSegmentIdFromLayerSelectionValue,
} from "#src/layer/segmentation/selection.js";
import type { RenderLayerTransformOrError } from "#src/render_coordinate_transform.js";
import type { SkeletonNode } from "#src/skeleton/api.js";
import type { SpatialSkeletonDisplaySnapshot } from "#src/skeleton/edit/spatial_skeleton_edit_session.js";
import {
  executeSpatialSkeletonDeleteNode,
  executeSpatialSkeletonNodeConfidenceUpdate,
  executeSpatialSkeletonNodeDescriptionUpdate,
  executeSpatialSkeletonNodeRadiusUpdate,
  executeSpatialSkeletonNodeTrueEndUpdate,
  executeSpatialSkeletonReroot,
  showSpatialSkeletonActionError,
} from "#src/skeleton/edit/submit_edits.js";
import type { SpatialSkeletonAction } from "#src/skeleton/edit_commands.js";
import { SpatialSkeletonActions } from "#src/skeleton/edit_commands.js";
import type { SpatialSkeletonIdentityService } from "#src/skeleton/edit_queue/api.js";
import {
  getSkeletonNodeConfidence,
  getSkeletonNodeRadius,
  isSkeletonNodeTrueEnd,
} from "#src/skeleton/node_attributes.js";
import {
  classifySkeletonDisplayNodeType,
  getSkeletonNodeTypeLabel,
  SkeletonDisplayNodeType,
} from "#src/skeleton/node_types.js";
import { StatusMessage } from "#src/status.js";
import { getSkeletonNodeTypeIcon } from "#src/ui/skeleton_node_icons.js";
import { serializeColor } from "#src/util/color.js";
import { RefCounted } from "#src/util/disposable.js";
import type { vec3 } from "#src/util/geom.js";
import * as matrix from "#src/util/matrix.js";
import type { NullarySignal } from "#src/util/signal.js";
import { makeDeleteButton } from "#src/widget/delete_button.js";
import type { DependentViewContext } from "#src/widget/dependent_view_widget.js";
import { makeIcon } from "#src/widget/icon.js";

export type SkeletonNodeDetailsLayer = Pick<
  SegmentationUserLayer,
  | "spatialSkeletonEditSession"
  | "skeletonSourceConnection"
  | "skeletonNodeSelection"
  | "skeletonNodeAccess"
  | "selectSegment"
>;

export interface FormattedSkeletonNodePosition {
  readonly copyText: string;
  readonly displayText: string;
  readonly fullText: string;
}

function formatPosition(
  position: ArrayLike<number>,
  dimensionNames: readonly string[] = ["x", "y", "z"],
): FormattedSkeletonNodePosition {
  const [x, y, z] = [0, 1, 2].map((index) =>
    Math.round(Number(position[index])),
  );
  return {
    copyText: `${x}, ${y}, ${z}`,
    displayText: `${x} ${y} ${z}`,
    fullText: `${dimensionNames[0]}: ${x} ${dimensionNames[1]}: ${y} ${dimensionNames[2]}: ${z}`,
  };
}

export function formatSkeletonNodePosition(
  modelPosition: ArrayLike<number>,
  transform: RenderLayerTransformOrError | undefined,
): FormattedSkeletonNodePosition {
  if (transform === undefined || transform.error !== undefined) {
    return formatPosition(modelPosition);
  }
  const { rank } = transform;
  const paddedModelPosition = new Float32Array(rank);
  for (let i = 0; i < Math.min(modelPosition.length, rank); i++) {
    paddedModelPosition[i] = Number(modelPosition[i]);
  }
  const layerPosition = new Float32Array(rank);
  matrix.transformPoint(
    layerPosition,
    transform.modelToRenderLayerTransform,
    rank + 1,
    paddedModelPosition,
    rank,
  );
  return formatPosition(layerPosition, transform.layerDimensionNames);
}

export interface SkeletonSegmentColors {
  readonly changed: NullarySignal;
  get(segmentId: bigint): Float32Array;
}

function isProvisionalSkeletonSegment(
  presentation: SpatialSkeletonDisplaySnapshot,
  segmentId: bigint,
) {
  return presentation.numericAliases.some(
    (alias) => alias.segmentId === segmentId && !alias.authoritative,
  );
}

// The skeleton details label a provisional skeleton as Preview in place of the segment row.
export function selectsProvisionalSkeleton(
  layer: SkeletonNodeDetailsLayer,
  state: SegmentationLayerSelectionState,
) {
  const segmentId = getSegmentIdFromLayerSelectionValue(state);
  return (
    segmentId !== undefined &&
    isProvisionalSkeletonSegment(
      layer.spatialSkeletonEditSession.spatialSkeletonDisplay.value,
      segmentId,
    )
  );
}

function showProvisionalSegment(segmentChip: HTMLElement) {
  segmentChip.textContent = "Preview";
  segmentChip.title =
    "Preview skeleton. Red means the skeleton source has not yet confirmed its permanent skeleton ID.";
  segmentChip.style.backgroundColor = "rgb(255, 0, 0)";
  segmentChip.style.color = "#ffffff";
}

export function displaySkeletonNodeSelection(
  layer: SkeletonNodeDetailsLayer,
  state: SegmentationLayerSelectionState,
  parent: HTMLElement,
  context: DependentViewContext,
  segmentColors: SkeletonSegmentColors,
): boolean {
  const nodeId = getNodeIdFromLayerSelectionState(state);
  if (nodeId === undefined) {
    if (!selectsProvisionalSkeleton(layer, state)) return false;
    const segmentChip = document.createElement("span");
    segmentChip.classList.add(
      "neuroglancer-selection-details-skeleton-segment-chip",
    );
    showProvisionalSegment(segmentChip);
    const element = document.createElement("div");
    element.classList.add("neuroglancer-selection-details-skeleton");
    element.appendChild(makePropertyRow("Segment ID", segmentChip));
    parent.appendChild(element);
    return true;
  }
  const details = context.registerDisposer(
    new SkeletonNodeDetails(
      layer,
      nodeId,
      getSegmentIdFromLayerSelectionValue(state),
      segmentColors,
    ),
  );
  parent.appendChild(details.element);
  return true;
}

enum SkeletonNodeDetailsKind {
  MISSING,
  OUTLINE,
  COMPLETE,
}

interface SkeletonProvisionalIds {
  readonly node: boolean;
  readonly segment: boolean;
}

interface SkeletonNodeOutline {
  readonly kind: SkeletonNodeDetailsKind.OUTLINE;
  readonly segmentId: bigint;
  readonly nodeTypeLabel: string | undefined;
  readonly position: FormattedSkeletonNodePosition | undefined;
  readonly provisional: SkeletonProvisionalIds;
}

interface SkeletonNodeDisabledReasons {
  readonly deleteNode: string | undefined;
  readonly reroot: string | undefined;
  readonly trueEnd: string | undefined;
  readonly radius: string | undefined;
  readonly confidence: string | undefined;
  readonly description: string | undefined;
}

interface CompleteSkeletonNode {
  readonly kind: SkeletonNodeDetailsKind.COMPLETE;
  readonly node: SkeletonNode;
  readonly nodeType: SkeletonDisplayNodeType;
  readonly nodeIsTrueEnd: boolean;
  readonly isLeaf: boolean;
  readonly position: FormattedSkeletonNodePosition;
  readonly provisional: SkeletonProvisionalIds;
  readonly confidenceValues: readonly number[] | undefined;
  readonly disabledReasons: SkeletonNodeDisabledReasons;
}

type SkeletonNodeDetailsModel =
  | { readonly kind: SkeletonNodeDetailsKind.MISSING }
  | SkeletonNodeOutline
  | CompleteSkeletonNode;

const NO_EDITABLE_SOURCE_REASON =
  "Unable to resolve editable skeleton source for the active layer.";

function readSkeletonNodeDetails(
  layer: SkeletonNodeDetailsLayer,
  nodeId: bigint,
  selectedSegmentId: bigint | undefined,
): SkeletonNodeDetailsModel {
  const {
    spatialSkeletonEditSession,
    skeletonSourceConnection: connection,
    skeletonNodeSelection: selection,
  } = layer;
  const transform = layer.skeletonNodeAccess.value?.displayState.transform
    .value as RenderLayerTransformOrError | undefined;
  const presentation = spatialSkeletonEditSession.spatialSkeletonDisplay.value;
  const getProvisionalIds = (segmentId: bigint): SkeletonProvisionalIds => ({
    node: (presentation.provisionalNodeIds ?? []).includes(nodeId),
    segment: isProvisionalSkeletonSegment(presentation, segmentId),
  });
  const skeletonLayer = connection.getSpatiallyIndexedSkeletonLayer();
  const cachedNode = spatialSkeletonEditSession.getCachedNode(nodeId);
  const node = skeletonLayer?.getNode(nodeId) ?? cachedNode;
  if (node === undefined) {
    const selected = selection.selected.value;
    const segmentId =
      (selected?.nodeId === nodeId ? selected.segmentId : undefined) ??
      selectedSegmentId;
    if (segmentId === undefined) {
      return { kind: SkeletonNodeDetailsKind.MISSING };
    }
    const graph = selection.navigator.getGraph(segmentId);
    const graphNode = graph?.nodeById.get(nodeId);
    return {
      kind: SkeletonNodeDetailsKind.OUTLINE,
      segmentId,
      provisional: getProvisionalIds(segmentId),
      nodeTypeLabel:
        graphNode === undefined
          ? undefined
          : getSkeletonNodeTypeLabel(
              classifySkeletonDisplayNodeType(
                graphNode,
                graph!.childrenByParent.get(nodeId)?.length ?? 0,
              ),
              isSkeletonNodeTrueEnd(graphNode),
            ),
      position:
        graphNode === undefined
          ? undefined
          : formatSkeletonNodePosition(graphNode.position, transform),
    };
  }
  const segmentNodes = spatialSkeletonEditSession.getCachedSegmentNodes(
    node.segmentId,
  );
  const childCount = segmentNodes?.filter(
    (candidate) => candidate.parentNodeId === node.nodeId,
  ).length;
  const nodeIsTrueEnd = isSkeletonNodeTrueEnd(node);
  const editSource = skeletonLayer?.editableSource;
  const editReason = (action: SpatialSkeletonAction, loadMessage: string) =>
    editSource === undefined
      ? NO_EDITABLE_SOURCE_REASON
      : cachedNode === undefined
        ? loadMessage
        : connection.getActionsDisabledReason(action);
  return {
    kind: SkeletonNodeDetailsKind.COMPLETE,
    node,
    nodeType: classifySkeletonDisplayNodeType(node, childCount),
    nodeIsTrueEnd,
    isLeaf: childCount === 0,
    position: formatSkeletonNodePosition(node.position, transform),
    provisional: getProvisionalIds(node.segmentId),
    confidenceValues: editSource?.confidenceValues,
    disabledReasons: {
      deleteNode:
        editSource === undefined
          ? NO_EDITABLE_SOURCE_REASON
          : segmentNodes === undefined
            ? "Load the active skeleton in the Skeleton tab before deleting from Selection."
            : node.parentNodeId === undefined && childCount! > 0
              ? "Reroot the skeleton manually before deleting the current root node."
              : connection.getActionsDisabledReason(
                  SpatialSkeletonActions.deleteNodes,
                ),
      reroot:
        node.parentNodeId === undefined
          ? "Selected node is already root."
          : nodeIsTrueEnd
            ? "True end nodes cannot be set as root. Clear the true end state first."
            : (connection.getActionsDisabledReason(
                SpatialSkeletonActions.reroot,
              ) ??
              (segmentNodes === undefined
                ? "Load the active skeleton in the Skeleton tab before rerooting from Selection."
                : undefined)),
      trueEnd: editReason(
        SpatialSkeletonActions.editNodeTrueEnd,
        "Load the active skeleton in the Skeleton tab before changing leaf type.",
      ),
      radius: editReason(
        SpatialSkeletonActions.editNodeRadius,
        "Load the active skeleton in the Skeleton tab before editing radius.",
      ),
      confidence: editReason(
        SpatialSkeletonActions.editNodeConfidence,
        "Load the active skeleton in the Skeleton tab before editing confidence.",
      ),
      description: editReason(
        SpatialSkeletonActions.editNodeDescription,
        "Load the active skeleton in the Skeleton tab before editing description.",
      ),
    },
  };
}

// Editors rebuild only when this changes, so typed input survives updates.
function getStructureKey(model: SkeletonNodeDetailsModel) {
  if (model.kind !== SkeletonNodeDetailsKind.COMPLETE) return `${model.kind}`;
  const { disabledReasons } = model;
  return [
    model.kind,
    disabledReasons.radius === undefined,
    disabledReasons.confidence === undefined,
    disabledReasons.description === undefined,
    model.confidenceValues?.join(","),
  ].join(";");
}

function makePropertyRow(label: string, value: string | HTMLElement) {
  const row = document.createElement("div");
  row.classList.add("neuroglancer-annotation-property");
  const nameElement = document.createElement("div");
  nameElement.classList.add("neuroglancer-annotation-property-label");
  nameElement.textContent = label;
  const valueElement = document.createElement("div");
  valueElement.classList.add("neuroglancer-annotation-property-value");
  valueElement.append(value);
  row.append(nameElement, valueElement);
  return row;
}

function setDisabledReason(
  element: HTMLElement,
  disabledReason: string | undefined,
  enabledTitle?: string,
) {
  const title = disabledReason ?? enabledTitle;
  if (title === undefined) {
    element.removeAttribute("title");
  } else {
    element.title = title;
  }
}

function formatEditableNumber(value: number | undefined, fallback = "0") {
  return value === undefined ? fallback : `${value}`;
}

// Swapping children only on change keeps the focused element's focus.
function showChildren(parent: HTMLElement, children: readonly HTMLElement[]) {
  const current = parent.children;
  if (
    current.length === children.length &&
    children.every((child, index) => current[index] === child)
  ) {
    return;
  }
  parent.replaceChildren(...children);
}

class SkeletonNodeDetails extends RefCounted {
  readonly element = document.createElement("div");
  private structureKey: string | undefined;
  private structureLifetime: RefCounted | undefined;
  private shownInputs: readonly unknown[] | undefined;
  private refreshShownNode:
    | ((model: SkeletonNodeDetailsModel) => void)
    | undefined;
  private nodeHandle:
    | {
        readonly identities: SpatialSkeletonIdentityService;
        readonly node: ReturnType<
          SpatialSkeletonIdentityService["getOrCreateNodeHandle"]
        >;
      }
    | undefined;

  constructor(
    private readonly layer: SkeletonNodeDetailsLayer,
    private readonly selectedNodeId: bigint,
    private readonly selectedSegmentId: bigint | undefined,
    private readonly segmentColors: SkeletonSegmentColors,
  ) {
    super();
    this.element.classList.add("neuroglancer-selection-details-skeleton");
    const {
      spatialSkeletonEditSession,
      skeletonNodeAccess,
      skeletonNodeSelection,
    } = layer;
    const update = () => this.update();
    this.registerDisposer(
      spatialSkeletonEditSession.nodeDataVersion.changed.add(update),
    );
    this.registerDisposer(
      spatialSkeletonEditSession.spatialSkeletonDisplay.changed.add(update),
    );
    this.registerDisposer(skeletonNodeSelection.selected.changed.add(update));
    this.registerDisposer(segmentColors.changed.add(update));
    let unbindNodesChanged: (() => void) | undefined;
    const bindNodeAccess = () => {
      unbindNodesChanged?.();
      unbindNodesChanged = skeletonNodeAccess.value?.nodesChanged.add(update);
      update();
    };
    this.registerDisposer(skeletonNodeAccess.changed.add(bindNodeAccess));
    this.registerDisposer(() => unbindNodesChanged?.());
    bindNodeAccess();
  }

  private update() {
    const inputs = this.readInputs();
    const { shownInputs } = this;
    if (
      shownInputs !== undefined &&
      inputs.every((input, index) => input === shownInputs[index])
    ) {
      return;
    }
    this.shownInputs = inputs;
    this.render();
  }

  // Everything the panel reads, by identity, so a chunk load elsewhere costs no work.
  private readInputs(): readonly unknown[] {
    const { layer } = this;
    const nodeId = this.getNodeId();
    const { spatialSkeletonEditSession, skeletonNodeSelection } = layer;
    const skeletonLayer =
      layer.skeletonSourceConnection.getSpatiallyIndexedSkeletonLayer();
    const cachedNode = spatialSkeletonEditSession.getCachedNode(nodeId);
    const node = skeletonLayer?.getNode(nodeId) ?? cachedNode;
    const selected = skeletonNodeSelection.selected.value;
    const segmentId =
      node?.segmentId ??
      (selected?.nodeId === nodeId ? selected.segmentId : undefined) ??
      this.selectedSegmentId;
    const nodeAccess = layer.skeletonNodeAccess.value;
    return [
      node,
      cachedNode,
      segmentId === undefined
        ? undefined
        : spatialSkeletonEditSession.getCachedSegmentNodes(segmentId),
      segmentId === undefined
        ? undefined
        : nodeAccess?.getSegmentNodes(segmentId),
      nodeAccess?.displayState.transform.value,
      selected,
      spatialSkeletonEditSession.spatialSkeletonDisplay.value,
      spatialSkeletonEditSession.nodeDataVersion.value,
      spatialSkeletonEditSession.getReloadRequired(),
      skeletonLayer,
      skeletonLayer?.editableSource,
      this.segmentColors.changed.count,
    ];
  }

  private render() {
    const model = readSkeletonNodeDetails(
      this.layer,
      this.getNodeId(),
      this.selectedSegmentId,
    );
    const structureKey = getStructureKey(model);
    if (structureKey !== this.structureKey) {
      this.structureKey = structureKey;
      this.structureLifetime?.dispose();
      const lifetime = (this.structureLifetime = new RefCounted());
      this.refreshShownNode = this.build(model, lifetime);
    }
    this.refreshShownNode?.(model);
  }

  disposed() {
    this.structureLifetime?.dispose();
    super.disposed();
  }

  private build(
    model: SkeletonNodeDetailsModel,
    lifetime: RefCounted,
  ): ((model: SkeletonNodeDetailsModel) => void) | undefined {
    this.element.replaceChildren();
    switch (model.kind) {
      case SkeletonNodeDetailsKind.MISSING: {
        const message = document.createElement("div");
        message.classList.add(
          "neuroglancer-selection-details-segment-description",
        );
        message.textContent =
          "Selected node is not available in the current loaded or cached skeleton data.";
        this.element.appendChild(message);
        return undefined;
      }
      case SkeletonNodeDetailsKind.OUTLINE:
        return this.buildOutline();
      case SkeletonNodeDetailsKind.COMPLETE:
        return this.buildComplete(model, lifetime);
    }
  }

  private buildOutline() {
    const nodeTypeValue = document.createElement("span");
    const positionValue = document.createElement("span");
    const nodeTypeRow = makePropertyRow("Node type", nodeTypeValue);
    const positionRow = makePropertyRow("Position", positionValue);
    const identifiers = new SkeletonNodeIdentifiers(
      this.layer,
      this.segmentColors,
    );
    return (model: SkeletonNodeDetailsModel) => {
      if (model.kind !== SkeletonNodeDetailsKind.OUTLINE) return;
      const rows: HTMLElement[] = [];
      if (model.nodeTypeLabel !== undefined && model.position !== undefined) {
        nodeTypeValue.textContent = model.nodeTypeLabel;
        positionValue.textContent = model.position.displayText;
        positionValue.title = model.position.fullText;
        rows.push(nodeTypeRow, positionRow);
      }
      identifiers.update(model.segmentId, this.getNodeId(), model.provisional);
      showChildren(this.element, [...rows, ...identifiers.rows]);
    };
  }

  private buildComplete(
    initialModel: CompleteSkeletonNode,
    lifetime: RefCounted,
  ) {
    const { layer } = this;
    const connection = layer.skeletonSourceConnection;
    const summary = document.createElement("div");
    summary.classList.add("neuroglancer-selection-details-skeleton-summary");
    const icon = document.createElement("span");
    icon.classList.add("neuroglancer-selection-details-skeleton-summary-icon");
    const coordinates = document.createElement("span");
    coordinates.classList.add(
      "neuroglancer-selection-details-skeleton-summary-coordinates",
    );
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.classList.add(
      "neuroglancer-selection-details-skeleton-action",
    );
    let deletePending = false;
    deleteButton.addEventListener("click", () => {
      if (deleteButton.disabled || deletePending) return;
      deletePending = true;
      void (async () => {
        try {
          await executeSpatialSkeletonDeleteNode(
            connection,
            this.getNodeForEdit(),
          );
        } catch (error) {
          showSpatialSkeletonActionError(
            SpatialSkeletonActions.deleteNodes,
            error,
          );
        } finally {
          deletePending = false;
        }
      })();
    });
    deleteButton.appendChild(makeDeleteButton({ clickable: false }));
    summary.append(icon, coordinates, deleteButton);
    let shownIconSvg: string | undefined;

    const identifiers = new SkeletonNodeIdentifiers(layer, this.segmentColors);
    let choicePending = false;
    const runChoice = (
      action: SpatialSkeletonAction,
      run: (node: SkeletonNode) => Promise<unknown>,
    ) => {
      if (choicePending) return;
      choicePending = true;
      this.render();
      void (async () => {
        try {
          await run(this.getNodeForEdit());
        } catch (error) {
          showSpatialSkeletonActionError(action, error);
        } finally {
          choicePending = false;
          this.render();
        }
      })();
    };
    const nodeTypeControl = lifetime.registerDisposer(
      new SkeletonNodeTypeControl({
        reroot: () =>
          runChoice(SpatialSkeletonActions.reroot, (node) =>
            executeSpatialSkeletonReroot(connection, node),
          ),
        setTrueEnd: (trueEnd) =>
          runChoice(SpatialSkeletonActions.editNodeTrueEnd, (node) =>
            executeSpatialSkeletonNodeTrueEndUpdate(connection, {
              node,
              nextIsTrueEnd: trueEnd,
            }),
          ),
      }),
    );
    const nodeTypeRow = makePropertyRow("Node type", nodeTypeControl.element);

    const { disabledReasons } = initialModel;
    const editors: SkeletonNodePropertyEditor[] = [];
    const makeEditorRow = (
      label: string,
      editable: boolean,
      readonlyText: (node: SkeletonNode) => string,
      makeEditor: () => SkeletonNodePropertyEditor,
    ) => {
      if (!editable) {
        const value = document.createElement("span");
        return {
          row: makePropertyRow(label, value),
          refresh: (node: SkeletonNode) => {
            value.textContent = readonlyText(node);
          },
        };
      }
      const editor = lifetime.registerDisposer(makeEditor());
      editors.push(editor);
      return { row: makePropertyRow(label, editor.control), refresh: () => {} };
    };
    const radius = makeEditorRow(
      "Radius",
      disabledReasons.radius === undefined,
      (node) =>
        formatEditableNumber(getSkeletonNodeRadius(node), "Unavailable"),
      () => {
        const input = document.createElement("input");
        input.type = "number";
        input.step = "any";
        return new SkeletonNodePropertyEditor(input, {
          action: SpatialSkeletonActions.editNodeRadius,
          read: (node) => formatEditableNumber(getSkeletonNodeRadius(node)),
          isSaved: (node, text) =>
            Number(text) === (getSkeletonNodeRadius(node) ?? 0),
          commitDelayMilliseconds: 500,
          validate: (text) =>
            Number.isFinite(Number(text))
              ? undefined
              : "Radius must be a finite number.",
          commit: (node, text) =>
            executeSpatialSkeletonNodeRadiusUpdate(connection, {
              node,
              nextRadius: Number(text),
            }),
          getNodeForEdit: () => this.getNodeForEdit(),
        });
      },
    );
    const confidence = makeEditorRow(
      "Confidence level",
      disabledReasons.confidence === undefined,
      (node) =>
        formatEditableNumber(getSkeletonNodeConfidence(node), "Unavailable"),
      () => {
        const committed = getSkeletonNodeConfidence(initialModel.node) ?? 0;
        const selectValues =
          initialModel.confidenceValues === undefined
            ? undefined
            : Array.from(
                new Set([...initialModel.confidenceValues, committed]),
              ).filter((value) => Number.isFinite(value));
        let control: HTMLInputElement | HTMLSelectElement;
        if (selectValues === undefined) {
          const input = document.createElement("input");
          input.type = "number";
          input.min = "0";
          input.max = "100";
          input.step = "any";
          control = input;
        } else {
          control = document.createElement("select");
          for (const value of selectValues) {
            const option = document.createElement("option");
            option.value = `${value}`;
            option.textContent = formatEditableNumber(value);
            control.appendChild(option);
          }
        }
        return new SkeletonNodePropertyEditor(control, {
          action: SpatialSkeletonActions.editNodeConfidence,
          read: (node) => `${getSkeletonNodeConfidence(node) ?? 0}`,
          isSaved: (node, text) =>
            Number(text) === (getSkeletonNodeConfidence(node) ?? 0),
          validate: (text) => {
            const value = Number(text);
            if (!Number.isFinite(value)) {
              return "Confidence must be a finite number.";
            }
            if (selectValues === undefined) {
              return value >= 0 && value <= 100
                ? undefined
                : "Confidence must be from 0 to 100.";
            }
            return selectValues.includes(value)
              ? undefined
              : "Confidence must use one of the supported values.";
          },
          commit: (node, text) =>
            executeSpatialSkeletonNodeConfidenceUpdate(connection, {
              node,
              nextConfidence: Number(text),
            }),
          getNodeForEdit: () => this.getNodeForEdit(),
        });
      },
    );
    let descriptionEditor: SkeletonNodePropertyEditor | undefined;
    const readonlyDescription = document.createElement("div");
    readonlyDescription.classList.add(
      "neuroglancer-selection-details-skeleton-description",
    );
    if (disabledReasons.description === undefined) {
      const textarea = document.createElement("textarea");
      textarea.classList.add(
        "neuroglancer-selection-details-skeleton-description",
      );
      textarea.rows = 3;
      textarea.placeholder = "Description";
      descriptionEditor = lifetime.registerDisposer(
        new SkeletonNodePropertyEditor(textarea, {
          action: SpatialSkeletonActions.editNodeDescription,
          read: (node) => node.description ?? "",
          isSaved: (node, text) => (node.description ?? "") === text,
          validate: () => undefined,
          commit: (node, text) =>
            executeSpatialSkeletonNodeDescriptionUpdate(connection, {
              node,
              nextDescription: text,
            }),
          getNodeForEdit: () => this.getNodeForEdit(),
        }),
      );
      editors.push(descriptionEditor);
    }
    if (editors.length > 0) this.ensureNodeHandle();

    return (model: SkeletonNodeDetailsModel) => {
      if (model.kind !== SkeletonNodeDetailsKind.COMPLETE) return;
      const { node, nodeType, nodeIsTrueEnd, position } = model;
      const reasons = model.disabledReasons;
      const nodeTypeLabel = getSkeletonNodeTypeLabel(nodeType, nodeIsTrueEnd);
      const iconSvg = getSkeletonNodeTypeIcon(nodeType, nodeIsTrueEnd);
      if (iconSvg !== shownIconSvg) {
        shownIconSvg = iconSvg;
        icon.replaceChildren(makeIcon({ svg: iconSvg, clickable: false }));
      }
      icon.title = nodeTypeLabel;
      coordinates.textContent = position.displayText;
      coordinates.title = position.fullText;
      deleteButton.disabled = reasons.deleteNode !== undefined;
      setDisabledReason(deleteButton, reasons.deleteNode, "Delete node");
      identifiers.update(node.segmentId, node.nodeId, model.provisional);
      const pendingReason = choicePending
        ? "Saving the previous change."
        : undefined;
      nodeTypeControl.update(
        { nodeType, nodeIsTrueEnd, isLeaf: model.isLeaf },
        {
          reroot: pendingReason ?? reasons.reroot,
          trueEnd: pendingReason ?? reasons.trueEnd,
        },
      );
      radius.refresh(node);
      confidence.refresh(node);
      for (const editor of editors) {
        const action = editor.action;
        editor.refresh(
          node,
          action === SpatialSkeletonActions.editNodeRadius
            ? reasons.radius
            : action === SpatialSkeletonActions.editNodeConfidence
              ? reasons.confidence
              : reasons.description,
        );
      }
      const description = node.description ?? "";
      readonlyDescription.textContent = description;
      setDisabledReason(readonlyDescription, reasons.description);
      showChildren(this.element, [
        summary,
        ...identifiers.rows,
        nodeTypeRow,
        radius.row,
        confidence.row,
        ...(descriptionEditor !== undefined
          ? [descriptionEditor.control]
          : description.length > 0
            ? [readonlyDescription]
            : []),
      ]);
    };
  }

  // While an editor is open, the node keeps its handle when the server renumbers it.
  private getNodeId() {
    const handle = this.nodeHandle;
    if (handle === undefined) return this.selectedNodeId;
    return handle.identities.resolveNode(handle.node) ?? this.selectedNodeId;
  }

  // Taken at render so a later edit still reaches the node after renumbering.
  private ensureNodeHandle() {
    if (this.nodeHandle !== undefined) return this.nodeHandle;
    const identities =
      this.layer.spatialSkeletonEditSession.getEditingIdentityService();
    return (this.nodeHandle = {
      identities,
      node: identities.getOrCreateNodeHandle(this.selectedNodeId),
    });
  }

  private getNodeForEdit(): SkeletonNode {
    const { spatialSkeletonEditSession } = this.layer;
    const { identities, node } = this.ensureNodeHandle();
    if (identities !== spatialSkeletonEditSession.getEditingIdentityService()) {
      throw new Error("The skeleton editor's source is no longer active.");
    }
    const currentNodeId = identities.resolveNode(node);
    const currentNode =
      currentNodeId === undefined
        ? undefined
        : spatialSkeletonEditSession.getCachedNode(currentNodeId);
    if (currentNode === undefined) {
      throw new Error(
        `Node ${this.selectedNodeId} is missing from the inspected skeleton cache.`,
      );
    }
    return currentNode;
  }
}

const SEGMENT_CHIP_TITLE =
  "Ctrl+right-click to pin selection\nCtrl+shift+right-click to unpin";

class SkeletonNodeIdentifiers {
  private readonly segmentChip = document.createElement("span");
  private readonly nodeIdValue = document.createElement("span");
  private segmentId: bigint | undefined;
  readonly rows: readonly HTMLElement[];

  constructor(
    layer: SkeletonNodeDetailsLayer,
    private readonly segmentColors: SkeletonSegmentColors,
  ) {
    const { segmentChip } = this;
    segmentChip.classList.add(
      "neuroglancer-selection-details-skeleton-segment-chip",
    );
    const hasSegmentSelectionModifiers = (event: MouseEvent) =>
      event.ctrlKey && !event.altKey && !event.metaKey;
    const selectSegment = (event: MouseEvent) => {
      if (this.segmentId === undefined) return;
      layer.selectSegment(
        this.segmentId,
        event.shiftKey ? "force-unpin" : true,
      );
    };
    segmentChip.addEventListener("mousedown", (event) => {
      if (event.button !== 2 || !hasSegmentSelectionModifiers(event)) return;
      selectSegment(event);
      event.preventDefault();
      event.stopPropagation();
    });
    segmentChip.addEventListener("contextmenu", (event) => {
      if (!hasSegmentSelectionModifiers(event)) return;
      if (event.button !== 2) selectSegment(event);
      event.preventDefault();
      event.stopPropagation();
    });
    this.rows = [
      makePropertyRow("Segment ID", segmentChip),
      makePropertyRow("Node ID", this.nodeIdValue),
    ];
  }

  update(
    segmentId: bigint,
    nodeId: bigint,
    provisional: SkeletonProvisionalIds,
  ) {
    const { segmentChip, nodeIdValue } = this;
    this.segmentId = segmentId;
    if (provisional.segment) {
      showProvisionalSegment(segmentChip);
    } else {
      const color = this.segmentColors.get(segmentId);
      const luminance = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2];
      segmentChip.textContent = `${segmentId}`;
      segmentChip.title = SEGMENT_CHIP_TITLE;
      segmentChip.style.backgroundColor = serializeColor(
        color.subarray(0, 3) as vec3,
      );
      segmentChip.style.color = luminance > 0.6 ? "#101010" : "#f5f5f5";
    }
    if (provisional.node) {
      nodeIdValue.textContent = "Preview";
      nodeIdValue.title =
        "Preview node. The skeleton source has not yet confirmed its permanent node ID.";
    } else {
      nodeIdValue.textContent = `${nodeId}`;
      nodeIdValue.removeAttribute("title");
    }
  }
}

interface SkeletonNodePropertyEditorOptions {
  readonly action: SpatialSkeletonAction;
  readonly read: (node: SkeletonNode) => string;
  readonly isSaved: (node: SkeletonNode, text: string) => boolean;
  // Spinner steps and typing within this delay save once.
  readonly commitDelayMilliseconds?: number;
  readonly validate: (text: string) => string | undefined;
  readonly commit: (node: SkeletonNode, text: string) => Promise<unknown>;
  readonly getNodeForEdit: () => SkeletonNode;
}

class SkeletonNodePropertyEditor extends RefCounted {
  private pending = false;
  private disabledReason: string | undefined;
  private shownNode: SkeletonNode | undefined;

  constructor(
    readonly control:
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement,
    private readonly options: SkeletonNodePropertyEditorOptions,
  ) {
    super();
    control.classList.add(
      "neuroglancer-selection-details-skeleton-properties-input",
    );
    this.registerEventListener(control, "input", () => this.updateState());
    const { commitDelayMilliseconds } = options;
    if (commitDelayMilliseconds === undefined) {
      this.registerEventListener(control, "change", () => this.commit());
    } else {
      const delayedCommit = this.registerCancellable(
        debounce(() => this.commit(), commitDelayMilliseconds),
      );
      this.registerEventListener(control, "change", delayedCommit);
      this.registerEventListener(control, "blur", () => delayedCommit.flush());
    }
    this.registerEventListener(control, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      if (control instanceof HTMLTextAreaElement && event.shiftKey) return;
      event.preventDefault();
      control.blur();
    });
  }

  get action() {
    return this.options.action;
  }

  refresh(node: SkeletonNode, disabledReason: string | undefined) {
    this.shownNode = node;
    this.disabledReason = disabledReason;
    if (!this.pending && document.activeElement !== this.control) {
      this.control.value = this.options.read(node);
    }
    this.updateState();
  }

  private updateState() {
    const { control, disabledReason } = this;
    const validationError = this.options.validate(control.value);
    control.disabled = disabledReason !== undefined || this.pending;
    control.toggleAttribute("data-invalid", validationError !== undefined);
    setDisabledReason(control, disabledReason ?? validationError);
  }

  private reset() {
    if (this.shownNode !== undefined) {
      this.control.value = this.options.read(this.shownNode);
    }
    this.updateState();
  }

  private commit() {
    if (this.pending) return;
    const { control, options } = this;
    const failure = this.disabledReason ?? options.validate(control.value);
    if (failure !== undefined) {
      StatusMessage.showTemporaryMessage(failure);
      this.reset();
      return;
    }
    const text = control.value;
    void (async () => {
      try {
        const node = options.getNodeForEdit();
        if (options.isSaved(node, text)) return;
        this.pending = true;
        this.updateState();
        await options.commit(node, text);
      } catch (error) {
        showSpatialSkeletonActionError(options.action, error);
      } finally {
        this.pending = false;
        this.reset();
      }
    })();
  }
}

enum SkeletonNodeTypeChoice {
  ROOT = "root",
  VIRTUAL_END = "virtual-end",
  TRUE_END = "true-end",
}

class SkeletonNodeTypeControl extends RefCounted {
  readonly element = document.createElement("div");
  private readonly label = document.createElement("span");
  private readonly buttons: Record<SkeletonNodeTypeChoice, HTMLButtonElement>;

  constructor(
    private readonly options: {
      readonly reroot: () => void;
      readonly setTrueEnd: (trueEnd: boolean) => void;
    },
  ) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-selection-details-skeleton-node-type");
    this.label.classList.add(
      "neuroglancer-selection-details-skeleton-node-type-label",
    );
    const makeButton = (
      choice: SkeletonNodeTypeChoice,
      text: string,
      svg: string,
      choose: () => void,
    ) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.choice = choice;
      button.classList.add(
        "neuroglancer-selection-details-skeleton-node-type-choice",
      );
      const textElement = document.createElement("span");
      textElement.textContent = text;
      button.append(
        makeIcon({ svg, title: text, clickable: false }),
        textElement,
      );
      this.registerEventListener(button, "click", () => {
        if (button.disabled || button.hasAttribute("data-checked")) return;
        choose();
      });
      return button;
    };
    this.buttons = {
      [SkeletonNodeTypeChoice.ROOT]: makeButton(
        SkeletonNodeTypeChoice.ROOT,
        "Root",
        getSkeletonNodeTypeIcon(SkeletonDisplayNodeType.ROOT, false),
        () => this.options.reroot(),
      ),
      [SkeletonNodeTypeChoice.VIRTUAL_END]: makeButton(
        SkeletonNodeTypeChoice.VIRTUAL_END,
        "Virtual end",
        getSkeletonNodeTypeIcon(SkeletonDisplayNodeType.VIRTUAL_END, false),
        () => this.options.setTrueEnd(false),
      ),
      [SkeletonNodeTypeChoice.TRUE_END]: makeButton(
        SkeletonNodeTypeChoice.TRUE_END,
        "True end",
        getSkeletonNodeTypeIcon(SkeletonDisplayNodeType.VIRTUAL_END, true),
        () => this.options.setTrueEnd(true),
      ),
    };
  }

  update(
    node: {
      readonly nodeType: SkeletonDisplayNodeType;
      readonly nodeIsTrueEnd: boolean;
      readonly isLeaf: boolean;
    },
    disabledReasons: {
      readonly reroot: string | undefined;
      readonly trueEnd: string | undefined;
    },
  ): void {
    const { buttons, label } = this;
    const isRoot = node.nodeType === SkeletonDisplayNodeType.ROOT;
    const offersEndType = node.isLeaf || node.nodeIsTrueEnd;
    const setChoice = (
      choice: SkeletonNodeTypeChoice,
      checked: boolean,
      disabledReason: string | undefined,
    ) => {
      const button = buttons[choice];
      button.toggleAttribute("data-checked", checked);
      button.disabled = checked || disabledReason !== undefined;
      setDisabledReason(button, checked ? undefined : disabledReason);
    };
    setChoice(SkeletonNodeTypeChoice.ROOT, isRoot, disabledReasons.reroot);
    setChoice(
      SkeletonNodeTypeChoice.VIRTUAL_END,
      offersEndType && !node.nodeIsTrueEnd,
      disabledReasons.trueEnd,
    );
    setChoice(
      SkeletonNodeTypeChoice.TRUE_END,
      node.nodeIsTrueEnd,
      disabledReasons.trueEnd,
    );
    const shown: HTMLElement[] = [];
    if (!isRoot && !offersEndType) {
      label.textContent = getSkeletonNodeTypeLabel(
        node.nodeType,
        node.nodeIsTrueEnd,
      );
      shown.push(label);
    }
    shown.push(buttons[SkeletonNodeTypeChoice.ROOT]);
    if (offersEndType) {
      shown.push(
        buttons[SkeletonNodeTypeChoice.VIRTUAL_END],
        buttons[SkeletonNodeTypeChoice.TRUE_END],
      );
    }
    showChildren(this.element, shown);
  }
}

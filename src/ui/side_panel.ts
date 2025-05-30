/**
 * @license
 * Copyright 2021 Google Inc.
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

import "#src/ui/side_panel.css";

import type { DisplayContext } from "#src/display_context.js";
import { popDragStatus, pushDragStatus } from "#src/ui/drag_and_drop.js";
import type { Side, SidePanelLocation } from "#src/ui/side_panel_location.js";
import { TrackableSidePanelLocation } from "#src/ui/side_panel_location.js";
import { RefCounted } from "#src/util/disposable.js";
import { updateChildren } from "#src/util/dom.js";
import {
  getDropEffect,
  getDropEffectFromModifiers,
  setDropEffect,
} from "#src/util/drag_and_drop.js";
import { startRelativeMouseDrag } from "#src/util/mouse_drag.js";
import { Signal } from "#src/util/signal.js";
import { WatchableVisibilityPriority } from "#src/visibility_priority/frontend.js";
import { makeCloseButton } from "#src/widget/close_button.js";

export const DRAG_OVER_CLASSNAME = "neuroglancer-drag-over";

type FlexDirection = "row" | "column";

const LOCATION_KEY_FOR_DIRECTION: Record<FlexDirection, "row" | "col"> = {
  row: "row",
  column: "col",
};

const OPPOSITE_SIDE: Record<Side, Side> = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
};
const FLEX_DIRECTION_FOR_SIDE: Record<Side, FlexDirection> = {
  left: "column",
  right: "column",
  top: "row",
  bottom: "row",
};
const CROSS_DIRECTION_FOR_SIDE: Record<Side, FlexDirection> = {
  left: "row",
  right: "row",
  top: "column",
  bottom: "column",
};
export const SIZE_FOR_DIRECTION: Record<FlexDirection, "width" | "height"> = {
  row: "width",
  column: "height",
};
const BEGIN_SIDE_FOR_DIRECTION: Record<FlexDirection, Side> = {
  row: "left",
  column: "top",
};
const END_SIDE_FOR_DIRECTION: Record<FlexDirection, Side> = {
  row: "right",
  column: "bottom",
};
const MARGIN_FOR_SIDE: Record<
  Side,
  "marginLeft" | "marginRight" | "marginTop" | "marginBottom"
> = {
  left: "marginLeft",
  right: "marginRight",
  top: "marginTop",
  bottom: "marginBottom",
};
const OUTWARDS_SIGN_FOR_SIDE: Record<Side, number> = {
  left: -1,
  right: +1,
  top: -1,
  bottom: +1,
};

export class SidePanel extends RefCounted {
  element: HTMLElement = document.createElement("div");
  visibility = new WatchableVisibilityPriority(
    WatchableVisibilityPriority.VISIBLE,
  );

  getDragDropDescription() {
    return "side panel";
  }

  constructor(
    public sidePanelManager: SidePanelManager,
    public location: TrackableSidePanelLocation = new TrackableSidePanelLocation(),
  ) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-side-panel");
    element.draggable = true;
    element.addEventListener("dragstart", (event: DragEvent) => {
      this.sidePanelManager.startDrag(this.makeDragSource(), event);
      element.style.backgroundColor = "black";
      setTimeout(() => {
        element.style.backgroundColor = "";
      }, 0);
      pushDragStatus(
        event,
        element,
        "drag",
        `Drag ${this.getDragDropDescription()} to move it to the left/right/top/bottom of another panel`,
      );
    });
    element.addEventListener("dragend", (event: DragEvent) => {
      this.sidePanelManager.endDrag();
      popDragStatus(event, element, "drag");
    });
  }

  canCopy() {
    return false;
  }

  copyToNewLocation(location: SidePanelLocation) {
    location;
  }

  makeDragSource(): DragSource {
    return {
      dropAsNewPanel: (location, dropEffect) => {
        const oldLocation = this.location.value;
        const newLocation: SidePanelLocation = { ...oldLocation, ...location };
        console.log({ oldLocation, newLocation });
        if (dropEffect === "copy") {
          this.copyToNewLocation(newLocation);
          return;
        }
        this.location.value = newLocation;
        this.location.locationChanged.dispatch();
      },
      getNewPanelDropEffect: (event) => {
        const description = this.getDragDropDescription();
        if (this.canCopy()) {
          const result = getDropEffectFromModifiers(
            event,
            /*defaultDropEffect=*/ "move",
            /*moveAllowed=*/ true,
          );
          return {
            description,
            ...result,
          };
        }
        return { description, dropEffect: "move" };
      },
    };
  }

  close() {
    this.location.visible = false;
  }

  addTitleBar(options: { title?: string }) {
    const titleBar = document.createElement("div");
    titleBar.classList.add("neuroglancer-side-panel-titlebar");
    const { title } = options;
    let titleElement: HTMLElement | undefined;
    if (title !== undefined) {
      titleElement = document.createElement("div");
      titleElement.classList.add("neuroglancer-side-panel-title");
      titleElement.textContent = title;
      titleBar.appendChild(titleElement);
    }
    const closeButton = makeCloseButton({
      title: "Close panel",
      onClick: () => {
        this.close();
      },
    });
    closeButton.style.order = "100";
    titleBar.appendChild(closeButton);
    this.element.appendChild(titleBar);
    return { titleBar, titleElement, closeButton };
  }

  addBody(body: HTMLElement) {
    body.draggable = true;
    body.addEventListener("dragstart", (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    });
    this.element.appendChild(body);
  }
}

interface SidePanelCell {
  registeredPanel: RegisteredSidePanel;
  gutterElement: HTMLElement | undefined;
}

interface SidePanelFlex {
  element: HTMLElement;
  visible: boolean;
  crossSize: number;
  // Maximum minWidth over all visible panels in the column.
  minSize: number;
  gutterElement: HTMLElement;
  cells: SidePanelCell[];

  beginDropZone: HTMLElement;
  endDropZone: HTMLElement;
}

interface SidePanelSideState {
  flexGroups: SidePanelFlex[];
  outerDropZoneElement: HTMLElement;
}

export interface SidePanelDropLocation {
  side: Side;
  row: number;
  col: number;
}

export interface DragSource {
  canDropAsTabs?: (target: SidePanel) => number;
  dropAsTab?: (target: SidePanel) => void;
  dropAsNewPanel: (
    location: SidePanelDropLocation,
    dropEffect: DataTransfer["dropEffect"],
  ) => void;
  getNewPanelDropEffect: (event: DragEvent) => {
    dropEffect: DataTransfer["dropEffect"];
    description: string;
    dropEffectMessage?: string;
    leaveHandler?: () => void;
  };
}

export interface RegisteredSidePanel {
  location: TrackableSidePanelLocation;
  makePanel: () => SidePanel;
  panel?: SidePanel | undefined;
}

export class SidePanelManager extends RefCounted {
  public element = document.createElement("div");
  public centerColumn = document.createElement("div");
  beforeRender = new Signal();
  private sides: Record<Side, SidePanelSideState> = {
    left: this.makeSidePanelSideState("left"),
    right: this.makeSidePanelSideState("right"),
    top: this.makeSidePanelSideState("top"),
    bottom: this.makeSidePanelSideState("bottom"),
  };
  private registeredPanels = new Set<RegisteredSidePanel>();
  dragSource: DragSource | undefined;
  private layoutNeedsUpdate = false;

  get visible() {
    return this.visibility.visible;
  }
  constructor(
    public display: DisplayContext,
    public center: HTMLElement,
    public visibility = new WatchableVisibilityPriority(
      WatchableVisibilityPriority.VISIBLE,
    ),
  ) {
    super();
    const { element, centerColumn } = this;
    element.style.display = "flex";
    element.style.flex = "1";
    element.style.flexDirection = "row";
    centerColumn.style.display = "flex";
    centerColumn.style.flex = "1";
    centerColumn.style.flexDirection = "column";
    centerColumn.style.flexBasis = "0px";
    centerColumn.style.minWidth = "0px";
    this.render();
    this.registerDisposer(
      display.updateStarted.add(() => {
        this.beforeRender.dispatch();
        if (!this.layoutNeedsUpdate) return;
        this.render();
        // Changing the side panel layout can affect the bounds of rendered panels as well.
        ++display.resizeGeneration;
      }),
    );
    this.registerDisposer(this.visibility.changed.add(this.invalidateLayout));
  }
  private makeSidePanelSideState(side: Side): SidePanelSideState {
    return {
      flexGroups: [],
      outerDropZoneElement: this.makeDropZone(
        side,
        /*crossIndex=*/ OUTWARDS_SIGN_FOR_SIDE[side] * Infinity,
        /*flexIndex=*/ 0,
        /*zoneSide=*/ side,
        /*centered=*/ false,
      ),
    };
  }

  hasDroppablePanel() {
    return this.dragSource !== undefined;
  }

  startDrag(dragSource: DragSource, event: DragEvent) {
    // Use setTimeout to set the attribute that enables the drop zones, rather than setting it
    // synchronously, as otherwise Chrome sometimes fires dragend immediately.
    //
    // https://stackoverflow.com/questions/14203734/dragend-dragenter-and-dragleave-firing-off-immediately-when-i-drag
    setTimeout(() => {
      if (this.dragSource === dragSource) {
        this.element.dataset.neuroglancerSidePanelDrag = "true";
      }
    }, 0);
    this.dragSource = dragSource;
    event.stopPropagation();
    event.dataTransfer!.setData("neuroglancer-side-panel", "");
  }

  endDrag() {
    delete this.element.dataset.neuroglancerSidePanelDrag;
    this.dragSource = undefined;
  }

  private makeDropZone(
    side: Side,
    crossIndex: number,
    flexIndex: number,
    zoneSide: Side,
    centered = false,
  ): HTMLElement {
    const element = document.createElement("div");
    element.className = "neuroglancer-side-panel-drop-zone";
    const size = 10;
    const zoneFlexDirection = FLEX_DIRECTION_FOR_SIDE[zoneSide];
    const zoneCrossDirection = CROSS_DIRECTION_FOR_SIDE[zoneSide];
    element.style[SIZE_FOR_DIRECTION[zoneCrossDirection]] = `${size}px`;
    element.style[SIZE_FOR_DIRECTION[zoneFlexDirection]] = "100%";
    if (centered) {
      element.style.position = "absolute";
      element.style[zoneSide] = "50%";
      element.style[MARGIN_FOR_SIDE[zoneSide]] = "-${size/2}px";
    } else {
      element.style.position = "relative";
      element.style[MARGIN_FOR_SIDE[OPPOSITE_SIDE[zoneSide]]] = `-${size}px`;
    }

    const update = (event: DragEvent) => {
      const { dragSource } = this;
      if (dragSource === undefined) return false;
      event.preventDefault();
      const { dropEffect, description, dropEffectMessage, leaveHandler } =
        dragSource.getNewPanelDropEffect(event);
      setDropEffect(event, dropEffect);
      let message = `Drop to ${dropEffect} ${description} to new ${zoneFlexDirection}`;
      if (dropEffectMessage) message += ` (${dropEffectMessage})`;
      pushDragStatus(event, element, "drop", message, leaveHandler);
      return true;
    };
    element.addEventListener("dragenter", (event) => {
      if (!update(event)) return;
      element.classList.add(DRAG_OVER_CLASSNAME);
      event.preventDefault();
    });
    element.addEventListener("dragleave", (event) => {
      popDragStatus(event, element, "drop");
      element.classList.remove(DRAG_OVER_CLASSNAME);
    });
    element.addEventListener("dragover", (event) => {
      if (!update(event)) return;
      event.preventDefault();
    });
    element.addEventListener("drop", (event) => {
      const { dragSource } = this;
      if (dragSource === undefined) return;
      popDragStatus(event, element, "drop");
      element.classList.remove(DRAG_OVER_CLASSNAME);
      const flexDirection = FLEX_DIRECTION_FOR_SIDE[side];
      dragSource.dropAsNewPanel(
        {
          side,
          row: flexDirection === "column" ? flexIndex : crossIndex,
          col: flexDirection === "row" ? flexIndex : crossIndex,
        },
        getDropEffect() ?? "none",
      );
      this.dragSource = undefined;
      event.preventDefault();
      event.stopPropagation();
    });
    return element;
  }

  registerPanel(registeredPanel: RegisteredSidePanel) {
    this.registeredPanels.add(registeredPanel);
    this.invalidateLayout();
    registeredPanel.location.locationChanged.add(this.invalidateLayout);
    return () => {
      this.unregisterPanel(registeredPanel);
    };
  }

  unregisterPanel(registeredPanel: RegisteredSidePanel) {
    this.registeredPanels.delete(registeredPanel);
    registeredPanel.location.locationChanged.remove(this.invalidateLayout);
    registeredPanel.panel?.dispose();
    this.invalidateLayout();
  }

  disposed() {
    for (const { panel } of this.registeredPanels) {
      panel?.dispose();
    }
    super.disposed();
  }

  invalidateLayout = () => {
    this.layoutNeedsUpdate = true;
    this.display.scheduleRedraw();
  };

  render() {
    this.layoutNeedsUpdate = false;
    const sides: Record<Side, RegisteredSidePanel[]> = {
      left: [],
      right: [],
      top: [],
      bottom: [],
    };
    for (const panel of this.registeredPanels) {
      sides[panel.location.value.side].push(panel);
    }
    const getSideChildren = (side: Side) =>
      this.renderSide(side, this.sides[side].flexGroups, sides[side]);
    const self = this;
    function* getRowChildren() {
      yield self.sides.left.outerDropZoneElement;
      yield* getSideChildren("left");
      yield self.centerColumn;
      yield* getSideChildren("right");
      yield self.sides.right.outerDropZoneElement;
    }
    updateChildren(this.element, getRowChildren());
    function* getColumnChildren() {
      yield self.sides.top.outerDropZoneElement;
      yield* getSideChildren("top");
      yield self.center;
      yield* getSideChildren("bottom");
      yield self.sides.bottom.outerDropZoneElement;
    }
    updateChildren(this.centerColumn, getColumnChildren());
  }

  private makeCrossGutter(side: Side, crossIndex: number) {
    const gutter = document.createElement("div");
    gutter.style.position = "relative";
    const direction = CROSS_DIRECTION_FOR_SIDE[side];
    gutter.className = `neuroglancer-resize-gutter-${
      direction === "row" ? "horizontal" : "vertical"
    }`;
    gutter.addEventListener("pointerdown", (event) => {
      if ("button" in event && event.button !== 0) {
        return;
      }
      event.preventDefault();
      const flexGroup = this.sides[side].flexGroups[crossIndex];
      if (flexGroup === undefined || !flexGroup.visible) return;
      // Get initial size
      const initialRect = flexGroup.element.getBoundingClientRect();
      let size = initialRect[SIZE_FOR_DIRECTION[direction]];
      const minSize = flexGroup.minSize;
      const updateMessage = () => {
        pushDragStatus(
          event,
          gutter,
          "drag",
          `Drag to resize, current ${SIZE_FOR_DIRECTION[direction]} is ${flexGroup.crossSize}px`,
        );
      };
      updateMessage();
      startRelativeMouseDrag(
        event,
        (_event, deltaX: number, deltaY: number) => {
          const delta = direction === "row" ? deltaX : deltaY;
          size -= OUTWARDS_SIGN_FOR_SIDE[side] * delta;
          flexGroup.crossSize = Math.max(minSize, Math.round(size));
          updateMessage();
          this.invalidateLayout();
        },
        (event) => {
          popDragStatus(event, gutter, "drag");
        },
      );
    });
    const dropZone = this.makeDropZone(
      side,
      crossIndex - OUTWARDS_SIGN_FOR_SIDE[side] * 0.5,
      /*flexIndex=*/ 0,
      /*zoneSide=*/ side,
      /*centered=*/ true,
    );
    gutter.appendChild(dropZone);
    return gutter;
  }

  private makeFlexGutter(side: Side, crossIndex: number, flexIndex: number) {
    const gutter = document.createElement("div");
    gutter.style.position = "relative";
    const direction = FLEX_DIRECTION_FOR_SIDE[side];
    gutter.className = `neuroglancer-resize-gutter-${
      direction === "row" ? "horizontal" : "vertical"
    }`;
    gutter.addEventListener("pointerdown", (event) => {
      if ("button" in event && event.button !== 0) {
        return;
      }
      event.preventDefault();
      const flexGroup = this.sides[side].flexGroups[crossIndex];
      if (flexGroup === undefined || !flexGroup.visible) return;
      const { cells } = flexGroup;
      const cell = cells[flexIndex];
      if (cell === undefined || !cell.registeredPanel.location.visible) return;
      // Determine the cell index of the next visible panel.
      let nextFlexIndex = flexIndex + 1;
      while (
        nextFlexIndex < cells.length &&
        !cells[nextFlexIndex].registeredPanel.location.visible
      ) {
        ++nextFlexIndex;
      }
      if (nextFlexIndex === cells.length) return;
      const nextCell = cells[nextFlexIndex];
      const updateMessage = (event: MouseEvent) => {
        pushDragStatus(
          event,
          gutter,
          "drag",
          `Drag to resize, current ${SIZE_FOR_DIRECTION[direction]} ratio is ` +
            `${cell.registeredPanel.location.value.flex} : ` +
            `${nextCell.registeredPanel.location.value.flex}`,
        );
      };
      updateMessage(event);
      startRelativeMouseDrag(
        event,
        (newEvent) => {
          const firstPanel = cell.registeredPanel.panel;
          const secondPanel = nextCell.registeredPanel.panel;
          if (firstPanel === undefined || secondPanel === undefined) return;
          const firstRect = firstPanel.element.getBoundingClientRect();
          const secondRect = secondPanel.element.getBoundingClientRect();
          const firstFraction = Math.max(
            0.1,
            Math.min(
              0.9,
              direction === "column"
                ? (newEvent.clientY - firstRect.top) /
                    (secondRect.bottom - firstRect.top)
                : (newEvent.clientX - firstRect.left) /
                    (secondRect.right - firstRect.left),
            ),
          );
          const firstLocation = cell.registeredPanel.location.value;
          const secondLocation = nextCell.registeredPanel.location.value;
          const existingFlexSum = firstLocation.flex + secondLocation.flex;
          cell.registeredPanel.location.value = {
            ...firstLocation,
            flex: Math.round(firstFraction * existingFlexSum * 100) / 100,
          };
          nextCell.registeredPanel.location.value = {
            ...secondLocation,
            flex: Math.round((1 - firstFraction) * existingFlexSum * 100) / 100,
          };
          updateMessage(newEvent);
          cell.registeredPanel.location.locationChanged.dispatch();
          nextCell.registeredPanel.location.locationChanged.dispatch();
          this.invalidateLayout();
        },
        (event) => {
          popDragStatus(event, gutter, "drag");
        },
      );
    });
    const dropZone = this.makeDropZone(
      side,
      crossIndex,
      /*flexIndex=*/ flexIndex + 0.5,
      /*zoneSide=*/ BEGIN_SIDE_FOR_DIRECTION[FLEX_DIRECTION_FOR_SIDE[side]],
      /*centered=*/ true,
    );
    gutter.appendChild(dropZone);
    return gutter;
  }

  private renderSide(
    side: Side,
    flexGroups: SidePanelFlex[],
    panels: RegisteredSidePanel[],
  ) {
    const flexKey = LOCATION_KEY_FOR_DIRECTION[CROSS_DIRECTION_FOR_SIDE[side]];
    const crossKey = LOCATION_KEY_FOR_DIRECTION[FLEX_DIRECTION_FOR_SIDE[side]];
    panels.sort((a, b) => {
      const aLoc = a.location.value;
      const bLoc = b.location.value;
      const crossDiff = aLoc[crossKey] - bLoc[crossKey];
      if (crossDiff !== 0) return crossDiff;
      return aLoc[flexKey] - bLoc[flexKey];
    });
    const self = this;
    function* getFlexGroups() {
      let panelIndex = 0;
      const numPanels = panels.length;
      let crossIndex = 0;
      while (panelIndex < numPanels) {
        const origCrossIndex = panels[panelIndex].location.value[crossKey];
        let endPanelIndex = panelIndex;
        let numVisible = 0;
        let minSize = 0;
        do {
          const location = panels[endPanelIndex].location.value;
          if (location[crossKey] !== origCrossIndex) break;
          if (location.visible) {
            ++numVisible;
            minSize = Math.max(minSize, location.minSize);
          }
          ++endPanelIndex;
        } while (endPanelIndex < numPanels);
        const visible = numVisible > 0;
        let flexGroup = flexGroups[crossIndex];
        if (flexGroup === undefined) {
          const gutter = self.makeCrossGutter(side, crossIndex);
          const flexGroupElement = document.createElement("div");
          flexGroupElement.className = `neuroglancer-side-panel-${FLEX_DIRECTION_FOR_SIDE[side]}`;
          flexGroup = flexGroups[crossIndex] = {
            element: flexGroupElement,
            gutterElement: gutter,
            cells: [],
            crossSize: -1,
            minSize,
            visible,
            beginDropZone: self.makeDropZone(
              side,
              crossIndex,
              /*flexIndex=*/ -Infinity,
              BEGIN_SIDE_FOR_DIRECTION[FLEX_DIRECTION_FOR_SIDE[side]],
            ),
            endDropZone: self.makeDropZone(
              side,
              crossIndex,
              /*flexIndex=*/ +Infinity,
              END_SIDE_FOR_DIRECTION[FLEX_DIRECTION_FOR_SIDE[side]],
            ),
          };
        } else {
          flexGroup.visible = visible;
          flexGroup.minSize = minSize;
          if (!visible) {
            flexGroup.crossSize = -1;
          }
        }
        function* getCells() {
          yield flexGroup.beginDropZone;
          let prevVisible = 0;
          for (
            let i = panelIndex, flexIndex = 0;
            i < endPanelIndex;
            ++i, ++flexIndex
          ) {
            const registeredPanel = panels[i];
            let cell = flexGroup.cells[flexIndex];
            if (cell === undefined) {
              cell = flexGroup.cells[flexIndex] = {
                registeredPanel,
                gutterElement: undefined,
              };
            } else {
              cell.registeredPanel = registeredPanel;
            }
            const oldLocation = cell.registeredPanel.location.value;
            if (oldLocation.visible) {
              flexGroup.crossSize = Math.max(
                minSize,
                flexGroup.crossSize === -1
                  ? oldLocation.size
                  : flexGroup.crossSize,
              );
            }
            if (
              oldLocation[crossKey] !== crossIndex ||
              oldLocation[flexKey] !== flexIndex ||
              (oldLocation.visible && oldLocation.size !== flexGroup.crossSize)
            ) {
              cell.registeredPanel.location.value = {
                ...oldLocation,
                [crossKey]: crossIndex,
                [flexKey]: flexIndex,
                size: oldLocation.visible
                  ? flexGroup.crossSize
                  : oldLocation.size,
              };
              cell.registeredPanel.location.changed.dispatch();
            }
            const visible = oldLocation.visible && self.visibility.visible;
            let { panel } = registeredPanel;
            if (!visible) {
              if (panel !== undefined) {
                panel.dispose();
                registeredPanel.panel = undefined;
              }
              continue;
            }
            ++prevVisible;
            if (panel === undefined) {
              panel = registeredPanel.panel = registeredPanel.makePanel();
            }
            panel.element.style.flex =
              numVisible > 1 ? `${oldLocation.flex}` : "1";
            yield panel.element;
            if (prevVisible === numVisible) {
              // Last cell does not need its own resize gutter.
              cell.gutterElement = undefined;
            } else {
              if (cell.gutterElement === undefined) {
                cell.gutterElement = self.makeFlexGutter(
                  side,
                  crossIndex,
                  flexIndex,
                );
              }
              yield cell.gutterElement;
            }
          }
          yield flexGroup.endDropZone;
        }
        updateChildren(flexGroup.element, getCells());
        flexGroup.cells.length = endPanelIndex - panelIndex;
        if (visible) {
          flexGroup.element.style[
            SIZE_FOR_DIRECTION[CROSS_DIRECTION_FOR_SIDE[side]]
          ] = `${flexGroup.crossSize}px`;
          if (OUTWARDS_SIGN_FOR_SIDE[side] > 0) {
            yield flexGroup.gutterElement;
            yield flexGroup.element;
          } else {
            yield flexGroup.element;
            yield flexGroup.gutterElement;
          }
        }
        panelIndex = endPanelIndex;
        ++crossIndex;
      }
      flexGroups.length = crossIndex;
    }
    return getFlexGroups();
  }
}

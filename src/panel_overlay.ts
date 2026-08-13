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
 * DOM overlays positioned by projecting world-space positions to screen (e.g.
 * the picking indicator and skeleton node highlights), updated on a coalesced,
 * redraw-free pass independent of the WebGL render loop.
 *
 * The contract contains no neuroglancer-internal types, so render layers,
 * built-ins, and external code implement it identically.  Positions passed to
 * `PanelOverlayContext.project` are in the global coordinate space.
 */

import "#src/panel_overlay.css";

import type { WatchableValueInterface } from "#src/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import type { NullarySignal } from "#src/util/signal.js";

export interface PanelOverlayContext {
  /**
   * Projects a global-coordinate position to this panel's logical CSS pixels, or
   * returns `undefined` if it is off-screen / behind the camera / culled by the
   * cross-section slab.  `scale` (default 1) conveys depth (perspective view);
   * `opacity` (default 1) is the cross-section fade in slice views (1 on the
   * slice plane, falling to 0 at the slab edge).
   */
  project(
    position: Float32Array,
  ): { x: number; y: number; scale?: number; opacity?: number } | undefined;

  /**
   * The source's container for this panel; the source reconciles its children.
   * Created and removed by the panel.
   */
  readonly container: HTMLElement;

  /**
   * CSS pixels per render-viewport device pixel, for sizing overlays specified in
   * device pixels.
   */
  readonly cssPerDevicePixel: number;

  /**
   * The panel's type tags (e.g. `"perspective"`, `"cross-section"`), so a source
   * can adapt its rendering to the panel it is drawing in.
   */
  readonly panelTypes: readonly string[];
}

export interface PanelOverlaySource {
  /** Higher draws on top of lower.  Default 0.  (Picking indicator uses 100.) */
  readonly overlayPriority?: number;

  /** Dispatch to reposition the overlay on the next frame without a GL redraw. */
  readonly overlayUpdateNeeded: NullarySignal;

  /**
   * Optional runtime show/hide.  When present and `false`, the panel hides this
   * source's container and skips its update; changes trigger a coalesced pass.
   */
  readonly overlayVisible?: WatchableValueInterface<boolean>;

  /** Cheap, DOM-only update for one panel.  Must not touch the GL canvas. */
  updatePanelOverlays(ctx: PanelOverlayContext): void;
}

export function isPanelOverlaySource(x: unknown): x is PanelOverlaySource {
  return (
    typeof (x as Partial<PanelOverlaySource> | null | undefined)
      ?.updatePanelOverlays === "function"
  );
}

/**
 * Restricts a globally-registered source to a subset of panels.  When
 * `panelTypes` is omitted the source is shown on every data panel; otherwise it
 * is shown on a panel iff one of its {@link PanelOverlayHost.panelTypes} tags is
 * listed.  (An empty `panelTypes` therefore matches no panel.)
 */
export interface PanelOverlayTarget {
  readonly panelTypes?: readonly string[];
}

function panelMatchesTarget(
  target: PanelOverlayTarget,
  panelTypes: readonly string[],
): boolean {
  const { panelTypes: wanted } = target;
  return (
    wanted === undefined || wanted.some((type) => panelTypes.includes(type))
  );
}

/** The panel capabilities required by {@link PanelOverlayManager}. */
export interface PanelOverlayHost {
  readonly element: HTMLElement;
  readonly visible: boolean;
  readonly cssPerDevicePixel: number;
  readonly panelTypes: readonly string[];
  project(
    position: Float32Array,
  ): { x: number; y: number; scale?: number; opacity?: number } | undefined;
}

/**
 * Owns a panel's overlay DOM and drives its updates.  Holds a per-panel
 * container with one child per bound {@link PanelOverlaySource} (z-index from
 * `overlayPriority`), binds the viewer-level sources registered on the
 * DisplayContext, and repositions every source on `update()`.
 */
export class PanelOverlayManager extends RefCounted {
  private readonly container = document.createElement("div");
  private readonly bindings = new Map<PanelOverlaySource, HTMLElement>();
  private readonly globalOwners = new Map<PanelOverlaySource, RefCounted>();

  constructor(
    private readonly host: PanelOverlayHost,
    // Viewer-level sources (with their optional panel-type target) applied to this
    // panel when the target matches, and the signal fired when the map changes.
    private readonly globalSources: ReadonlyMap<
      PanelOverlaySource,
      PanelOverlayTarget
    >,
    globalSourcesChanged: NullarySignal,
    // Requests a coalesced, redraw-free overlay pass.
    private readonly requestUpdate: () => void,
  ) {
    super();
    this.container.className = "neuroglancer-panel-overlay-container";
    host.element.appendChild(this.container);
    this.registerDisposer(() => this.container.remove());
    this.registerDisposer(
      globalSourcesChanged.add(() => this.syncGlobalSources()),
    );
    this.registerDisposer(() => {
      for (const owner of this.globalOwners.values()) owner.dispose();
      this.globalOwners.clear();
    });
    this.syncGlobalSources();
  }

  /**
   * Binds `source`.  `owner` scopes the binding's lifetime; the source's
   * sub-container is removed when `owner` is disposed.
   */
  bindSource(source: PanelOverlaySource, owner: RefCounted) {
    const subContainer = document.createElement("div");
    subContainer.className = "neuroglancer-panel-overlay-source";
    subContainer.style.zIndex = `${source.overlayPriority ?? 0}`;
    this.container.appendChild(subContainer);
    this.bindings.set(source, subContainer);
    owner.registerDisposer(() => {
      subContainer.remove();
      this.bindings.delete(source);
      this.requestUpdate();
    });
    owner.registerDisposer(source.overlayUpdateNeeded.add(this.requestUpdate));
    const { overlayVisible } = source;
    if (overlayVisible !== undefined) {
      owner.registerDisposer(overlayVisible.changed.add(this.requestUpdate));
    }
    this.requestUpdate();
  }

  private syncGlobalSources() {
    const { globalSources, globalOwners, host } = this;
    for (const [source, owner] of globalOwners) {
      const target = globalSources.get(source);
      if (
        target === undefined ||
        !panelMatchesTarget(target, host.panelTypes)
      ) {
        owner.dispose();
        globalOwners.delete(source);
      }
    }
    for (const [source, target] of globalSources) {
      if (
        !globalOwners.has(source) &&
        panelMatchesTarget(target, host.panelTypes)
      ) {
        const owner = new RefCounted();
        globalOwners.set(source, owner);
        this.bindSource(source, owner);
      }
    }
  }

  /** Repositions every bound source.  DOM only; does not touch the GL canvas. */
  update() {
    const { host } = this;
    if (!host.visible) return;
    const { cssPerDevicePixel, panelTypes } = host;
    const project = (p: Float32Array) => host.project(p);
    for (const [source, container] of this.bindings) {
      if (source.overlayVisible?.value === false) {
        if (container.style.display !== "none")
          container.style.display = "none";
        continue;
      }
      if (container.style.display === "none") container.style.display = "";
      source.updatePanelOverlays({
        project,
        container,
        cssPerDevicePixel,
        panelTypes,
      });
    }
  }

  /**
   * Hides every bound source's container without touching the GL canvas.  Used
   * when the panel failed to draw (so it rendered nothing this frame) to avoid
   * leaving stale overlays over cleared canvas content.  {@link update}
   * restores visibility on the next successful frame.
   */
  clear() {
    for (const container of this.bindings.values()) {
      if (container.style.display !== "none") container.style.display = "none";
    }
  }
}

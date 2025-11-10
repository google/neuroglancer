/**
 * Vox Tool tab UI split from index.ts
 */
import type { VoxUserLayer } from "#src/layer/vox/index.js";
import { VoxelBrushLegacyTool } from "#src/ui/voxel_annotations.js";
import { Tab } from "#src/widget/tab_view.js";


export class VoxToolTab extends Tab {
  public requestRenderLabels() {
    this.renderLabels();
  }
  private labelsContainer!: HTMLDivElement;
  private labelsError!: HTMLDivElement;
  private renderLabels() {
    const cont = this.labelsContainer;
    cont.innerHTML = "";
    const labels = this.layer.voxLabels;
    const selected = this.layer.voxSelectedLabelId;
    for (const lab of labels) {
      const row = document.createElement("div");
      row.className = "neuroglancer-vox-label-row";
      row.style.display = "grid";
      row.style.gridTemplateColumns = "16px 1fr";
      row.style.alignItems = "center";
      row.style.gap = "8px";
      // color swatch
      const sw = document.createElement("div");
      sw.style.width = "16px";
      sw.style.height = "16px";
      sw.style.borderRadius = "3px";
      sw.style.border = "1px solid rgba(0,0,0,0.2)";
      sw.style.background = this.layer.colorForValue(lab.id);
      // id text (monospace)
      const txt = document.createElement("div");
      txt.textContent = String(lab.id >>> 0);
      txt.style.fontFamily = "monospace";
      txt.style.whiteSpace = "nowrap";
      txt.style.overflow = "hidden";
      txt.style.textOverflow = "ellipsis";
      row.appendChild(sw);
      row.appendChild(txt);
      // selection styling
      const isSel = lab.id === selected;
      row.style.cursor = "pointer";
      row.style.padding = "2px 4px";
      row.style.borderRadius = "4px";
      if (isSel) {
        row.style.background = "rgba(100,150,255,0.15)";
        row.style.outline = "1px solid rgba(100,150,255,0.6)";
      }
      row.addEventListener("click", () => {
        this.layer.selectVoxLabel(lab.id);
        this.renderLabels();
      });
      cont.appendChild(row);
    }
    // Update error message area
    const err = this.layer.voxLabelsError;
    if (err && err.length > 0) {
      this.labelsError.textContent = err;
      this.labelsError.style.display = "block";
    } else {
      this.labelsError.textContent = "";
      this.labelsError.style.display = "none";
    }
  }
  constructor(public layer: VoxUserLayer) {
    super();
    const { element } = this;
    element.classList.add("neuroglancer-vox-tools-tab");
    const toolbox = document.createElement("div");
    toolbox.className = "neuroglancer-vox-toolbox";

    // Section: Tool selection
    const toolsRow = document.createElement("div");
    toolsRow.className = "neuroglancer-vox-row";
    const toolsLabel = document.createElement("label");
    toolsLabel.textContent = "Tool";
    const toolsWrap = document.createElement("div");
    toolsWrap.style.display = "flex";
    toolsWrap.style.gap = "8px";

    const brushButton = document.createElement("button");
    brushButton.textContent = "Brush";
    brushButton.title = "ctrl+click to paint a small sphere";
    brushButton.addEventListener("click", () => {
      this.layer.tool.value = new VoxelBrushLegacyTool(this.layer);
    });

    toolsWrap.appendChild(brushButton);
    toolsRow.appendChild(toolsLabel);
    toolsRow.appendChild(toolsWrap);
    toolbox.appendChild(toolsRow);

    // Section: Brush settings
    const brushRow = document.createElement("div");
    brushRow.className = "neuroglancer-vox-row";

    // Brush size as slider + number readout
    const sizeLabel = document.createElement("label");
    sizeLabel.textContent = "Brush size";
    const sizeControls = document.createElement("div");
    sizeControls.style.display = "flex";
    sizeControls.style.alignItems = "center";
    sizeControls.style.gap = "8px";

    const sizeSlider = document.createElement("input");
    sizeSlider.type = "range";
    sizeSlider.min = "1";
    sizeSlider.max = "64";
    sizeSlider.step = "1";
    sizeSlider.value = String(this.layer.voxBrushRadius ?? 3);

    const sizeNumber = document.createElement("input");
    sizeNumber.type = "number";
    sizeNumber.className = "neuroglancer-vox-input";
    sizeNumber.min = "1";
    sizeNumber.step = "1";
    sizeNumber.value = String(this.layer.voxBrushRadius ?? 3);

    const syncSize = (v: number) => {
      const clamped = Math.max(1, Math.min(128, Math.floor(v)));
      this.layer.voxBrushRadius = clamped;
      sizeSlider.value = String(clamped);
      sizeNumber.value = String(clamped);
    };

    sizeSlider.addEventListener("input", () => {
      syncSize(Number(sizeSlider.value) || 1);
    });
    sizeNumber.addEventListener("change", () => {
      syncSize(Number(sizeNumber.value) || 1);
    });

    sizeControls.appendChild(sizeSlider);
    sizeControls.appendChild(sizeNumber);

    // Eraser toggle
    const erLabel = document.createElement("label");
    erLabel.textContent = "Eraser";
    const erChk = document.createElement("input");
    erChk.type = "checkbox";
    erChk.checked = !!this.layer.voxEraseMode;
    erChk.addEventListener("change", () => {
      this.layer.voxEraseMode = !!erChk.checked;
    });

    // Brush shape selector
    const shapeLabel = document.createElement("label");
    shapeLabel.textContent = "Brush shape";
    const shapeSel = document.createElement("select");
    const optDisk = document.createElement("option");
    optDisk.value = "disk";
    optDisk.textContent = "disk";
    const optSphere = document.createElement("option");
    optSphere.value = "sphere";
    optSphere.textContent = "sphere";
    shapeSel.appendChild(optDisk);
    shapeSel.appendChild(optSphere);
    shapeSel.value = this.layer.voxBrushShape === "sphere" ? "sphere" : "disk";
    shapeSel.addEventListener("change", () => {
      const v = shapeSel.value === "sphere" ? "sphere" : "disk";
      this.layer.voxBrushShape = v;
      shapeSel.value = v;
    });

    // Layout within the brushRow: size controls, shape, eraser
    const group = document.createElement("div");
    group.style.display = "grid";
    group.style.gridTemplateColumns = "minmax(120px,auto) 1fr";
    group.style.columnGap = "8px";
    group.style.rowGap = "8px";

    // Row 1: Brush size
    const sizeLabelCell = document.createElement("div");
    sizeLabelCell.appendChild(sizeLabel);
    const sizeControlsCell = document.createElement("div");
    sizeControlsCell.appendChild(sizeControls);

    // Row 2: Brush shape
    const shapeLabelCell = document.createElement("div");
    shapeLabelCell.appendChild(shapeLabel);
    const shapeControlCell = document.createElement("div");
    shapeControlCell.appendChild(shapeSel);

    // Row 3: Eraser
    const erLabelCell = document.createElement("div");
    erLabelCell.appendChild(erLabel);
    const erControlCell = document.createElement("div");
    erControlCell.appendChild(erChk);

    group.appendChild(sizeLabelCell);
    group.appendChild(sizeControlsCell);
    group.appendChild(shapeLabelCell);
    group.appendChild(shapeControlCell);
    group.appendChild(erLabelCell);
    group.appendChild(erControlCell);

    brushRow.appendChild(group);
    toolbox.appendChild(brushRow);

    // Section: Labels (moved to end, title on top for full width)
    const labelsSection = document.createElement("div");
    labelsSection.style.display = "flex";
    labelsSection.style.flexDirection = "column";
    labelsSection.style.gap = "6px";
    labelsSection.style.marginTop = "8px";

    const labelsTitle = document.createElement("div");
    labelsTitle.textContent = "Labels";
    labelsTitle.style.fontWeight = "600";

    const buttonsRow = document.createElement("div");
    buttonsRow.style.display = "flex";
    buttonsRow.style.gap = "8px";

    const createBtn = document.createElement("button");
    createBtn.textContent = "New label";
    createBtn.addEventListener("click", () => {
      this.layer.createVoxLabel();
      // Rendering will be triggered by layer via onLabelsChanged callback.
    });
    buttonsRow.appendChild(createBtn);

    this.labelsContainer = document.createElement("div");
    this.labelsContainer.className = "neuroglancer-vox-labels";
    this.labelsContainer.style.display = "flex";
    this.labelsContainer.style.flexDirection = "column";
    this.labelsContainer.style.gap = "4px";
    this.labelsContainer.style.maxHeight = "180px";
    this.labelsContainer.style.overflowY = "auto";

    this.labelsError = document.createElement("div");
    this.labelsError.className = "neuroglancer-vox-labels-error";
    this.labelsError.style.color = "#b00020"; // Material red 700-ish
    this.labelsError.style.fontSize = "12px";
    this.labelsError.style.whiteSpace = "pre-wrap";
    this.labelsError.style.display = "none";

    labelsSection.appendChild(labelsTitle);
    labelsSection.appendChild(buttonsRow);
    labelsSection.appendChild(this.labelsContainer);
    labelsSection.appendChild(this.labelsError);

    toolbox.appendChild(labelsSection);

    this.layer.onLabelsChanged = () => this.requestRenderLabels();
    this.renderLabels();

    element.appendChild(toolbox);
  }
}

import { SegmentColorHash } from "#src/segment_color.js";
import { DataType } from "#src/util/data_type.js";

export class LabelsManager {
  labels: Set<bigint>;
  selectedLabelId: bigint;
  labelsError: string | undefined = undefined;
  segmentColorHash = SegmentColorHash.getDefault();

  private sessionPrefix: bigint;
  private nextLocalId: bigint = 1n;

  constructor(public dataType: DataType, private onLabelsChanged?: () => void) {
    switch (dataType){
      case DataType.UINT32:
        this.sessionPrefix = BigInt(Date.now() << 20);
        break;
      case DataType.UINT64:
        this.sessionPrefix = BigInt(getRandomUint32()) << 32n;
        break;
      default:
        throw new Error(`LabelsManager: Unsupported data type: ${dataType}`);
    }
    this.labels = new Set<bigint>();
  }

  private generateNewGuid(): bigint {
    const newId = this.sessionPrefix | this.nextLocalId;
    this.nextLocalId++;
    return newId;
  }

  colorForValue(v: bigint): string {
    return this.segmentColorHash.computeCssColor(v);
  }

  createNewLabel() {
    const newId = this.generateNewGuid();
    this.addLabel(newId);
  }

  addLabel(id: number | bigint) {
    const newId = BigInt(id);
    if (newId === 0n) return;
    this.selectedLabelId = newId;
    this.labels.add(newId);
    this.onLabelsChanged?.();
  }

  selectVoxLabel(id: bigint) {
    if (this.labels.has(id)) {
      this.selectedLabelId = id;
      this.onLabelsChanged?.();
    }
  }

  getCurrentLabelValue(eraseMode: boolean): bigint {
    if (eraseMode) return 0n;
    return this.selectedLabelId ? this.selectedLabelId : 0n;
  }
}

function getRandomUint32(): number {
  if (typeof crypto !== "undefined" && (crypto as any).getRandomValues) {
    const a = new Uint32Array(1);
    (crypto as any).getRandomValues(a);
    return a[0]! >>> 0;
  }
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

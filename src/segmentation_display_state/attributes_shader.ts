import type { HashMapUint64 } from "#src/gpu_hash/hash_table.js";
import { GPUHashTable, HashMapShaderManager } from "#src/gpu_hash/shader.js";
import {
  ATTRIBUTE_GONE,
  ATTRIBUTE_HIDDEN,
  ATTRIBUTE_SHOWN,
  type SegmentAttributeTables,
} from "#src/segmentation_display_state/attributes.js";
import { RefCounted } from "#src/util/disposable.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";

// The attribute tables on the GPU, for any render layer that colors by them.
// `defineShader` adds to the fragment stage
//   bool getAttributeColor(uint64_t id, out vec4 color)
// which is false when the id should not draw: hidden, gone, unclassed, or its
// attributes not received yet.
export class AttributeShader extends RefCounted {
  private instancesManager = new HashMapShaderManager("instanceAttributes");
  private classesManager = new HashMapShaderManager("classAttributes");
  private gpuInstances: GPUHashTable<HashMapUint64>;
  private gpuClasses: GPUHashTable<HashMapUint64>;

  constructor(
    gl: GL,
    private tables: SegmentAttributeTables,
  ) {
    super();
    this.gpuInstances = this.registerDisposer(
      GPUHashTable.get(gl, tables.instances),
    );
    this.gpuClasses = this.registerDisposer(
      GPUHashTable.get(gl, tables.classes),
    );
  }

  defineShader(builder: ShaderBuilder) {
    this.instancesManager.defineShader(builder);
    this.classesManager.defineShader(builder);
    builder.addUniform("highp uint", "uAttributesHideByDefault");
    const hidden = `${ATTRIBUTE_HIDDEN}u`;
    const gone = `${ATTRIBUTE_GONE}u`;
    const shown = `${ATTRIBUTE_SHOWN}u`;
    builder.addFragmentCode(`
bool attributesHidden(uint instanceFlags, uint classFlags) {
  if ((instanceFlags & ${hidden}) != 0u) return true;
  if ((instanceFlags & ${shown}) != 0u) return false;
  if ((classFlags & ${hidden}) != 0u) return true;
  if ((classFlags & ${shown}) != 0u) return false;
  return uAttributesHideByDefault != 0u;
}
bool getAttributeColor(uint64_t id, out vec4 color) {
  uint64_t attrs;
  if (!${this.instancesManager.getFunctionName}(id, attrs)) return false;
  uint classIndex = attrs.value[0];
  if (classIndex == 0u || (attrs.value[1] & ${gone}) != 0u) return false;
  uint64_t key;
  key.value[0] = classIndex;
  key.value[1] = 0u;
  uint64_t classAttrs;
  if (!${this.classesManager.getFunctionName}(key, classAttrs)) return false;
  uint root = classAttrs.value[1] >> 8u;
  if (root != classIndex) {
    key.value[0] = root;
    if (!${this.classesManager.getFunctionName}(key, classAttrs)) return false;
  }
  if ((classAttrs.value[1] & ${gone}) != 0u) return false;
  if (attributesHidden(attrs.value[1] & 0xffu, classAttrs.value[1] & 0xffu)) {
    return false;
  }
  uint rgba = classAttrs.value[0];
  color = vec4(
    float((rgba >> 24u) & 0xffu),
    float((rgba >> 16u) & 0xffu),
    float((rgba >> 8u) & 0xffu),
    0.0) / 255.0;
  return true;
}
`);
  }

  enable(gl: GL, shader: ShaderProgram) {
    this.instancesManager.enable(gl, shader, this.gpuInstances);
    this.classesManager.enable(gl, shader, this.gpuClasses);
    gl.uniform1ui(
      shader.uniform("uAttributesHideByDefault"),
      this.tables.hideByDefault ? 1 : 0,
    );
  }

  disable(gl: GL, shader: ShaderProgram) {
    this.instancesManager.disable(gl, shader);
    this.classesManager.disable(gl, shader);
  }
}

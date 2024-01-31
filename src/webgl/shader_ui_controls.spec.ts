/**
 * @license
 * Copyright 2019 Google Inc.
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

import { DataType } from "#/util/data_type";
import { vec3, vec4 } from "#/util/geom";
import {
  parseShaderUiControls,
  stripComments,
} from "#/webgl/shader_ui_controls";
import { TRANSFER_FUNCTION_LENGTH } from "#/widget/transfer_function";
import { defaultDataTypeRange } from "#/util/lerp";

describe("stripComments", () => {
  it("handles code without comments", () => {
    const code = `int val;
void main() {
  int val2;
  int val2 = "string literal // here";
}
`;
    expect(stripComments(code)).toEqual(code);
  });

  it("handles // comments", () => {
    const original = `int val;
void main() {
  int val2; // comment at end of line
  int val2 = "string literal // here";
}
`;
    const stripped = `int val;
void main() {
  int val2;                          
  int val2 = "string literal // here";
}
`;
    expect(stripComments(original)).toEqual(stripped);
  });

  it("handles /* comments", () => {
    const original = `int val;
void main() {
  int val2; /* comment at end of line
  int val3; // continues here */
  int val2 = "string literal // here";
}
`;
    const stripped = `int val;
void main() {
  int val2;                          
                                
  int val2 = "string literal // here";
}
`;
    expect(stripComments(original)).toEqual(stripped);
  });
});

describe("parseShaderUiControls", () => {
  it("handles no controls", () => {
    const code = `
void main() {
  emitRGB(vec3(1.0, 1.0, 1.0));
}
`;
    expect(parseShaderUiControls(code)).toEqual({
      source: code,
      code,
      errors: [],
      controls: new Map(),
    });
  });

  it("handles slider control", () => {
    const code = `
#uicontrol float brightness slider(min=0, max=1)
void main() {
  emitRGB(vec3(1.0, 1.0, 1.0));
}
`;
    const newCode = `

void main() {
  emitRGB(vec3(1.0, 1.0, 1.0));
}
`;
    expect(parseShaderUiControls(code)).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "brightness",
          {
            type: "slider",
            valueType: "float",
            min: 0,
            max: 1,
            default: 0.5,
            step: 0.01,
          },
        ],
      ]),
    });
  });

  it("handles checkbox control", () => {
    const code = `
#uicontrol bool myCheckbox checkbox
#uicontrol bool myCheckbox2 checkbox(default=true)
void main() {
  emitRGB(vec3(1.0, 1.0, 1.0));
}
`;
    const newCode = `


void main() {
  emitRGB(vec3(1.0, 1.0, 1.0));
}
`;
    expect(parseShaderUiControls(code)).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        ["myCheckbox", { type: "checkbox", valueType: "bool", default: false }],
        ["myCheckbox2", { type: "checkbox", valueType: "bool", default: true }],
      ]),
    });
  });

  it("handles color control", () => {
    const code = `
#uicontrol vec3 color color(default="red")
void main() {
  emitRGB(color);
}
`;
    const newCode = `

void main() {
  emitRGB(color);
}
`;
    expect(parseShaderUiControls(code)).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "color",
          {
            type: "color",
            valueType: "vec3",
            default: vec3.fromValues(1, 0, 0),
            defaultString: "red",
          },
        ],
      ]),
    });
  });

  it("handles invlerp control without channel", () => {
    const code = `
#uicontrol invlerp normalized
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT8, channelRank: 0 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "normalized",
          {
            type: "imageInvlerp",
            dataType: DataType.UINT8,
            clamp: true,
            default: {
              range: [0, 255],
              window: [0, 255],
              channel: [],
            },
          },
        ],
      ]),
    });
  });

  it("handles invlerp control without channel (rank 1)", () => {
    const code = `
#uicontrol invlerp normalized
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT8, channelRank: 1 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "normalized",
          {
            type: "imageInvlerp",
            dataType: DataType.UINT8,
            clamp: true,
            default: {
              range: [0, 255],
              window: [0, 255],
              channel: [0],
            },
          },
        ],
      ]),
    });
  });

  it("handles invlerp control with channel (rank 0)", () => {
    const code = `
#uicontrol invlerp normalized(channel=[])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT8, channelRank: 0 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "normalized",
          {
            type: "imageInvlerp",
            dataType: DataType.UINT8,
            clamp: true,
            default: {
              range: [0, 255],
              window: [0, 255],
              channel: [],
            },
          },
        ],
      ]),
    });
  });

  it("handles invlerp control with non-array channel (rank 1)", () => {
    const code = `
#uicontrol invlerp normalized(channel=1)
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT8, channelRank: 1 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "normalized",
          {
            type: "imageInvlerp",
            dataType: DataType.UINT8,
            clamp: true,
            default: {
              range: [0, 255],
              window: [0, 255],
              channel: [1],
            },
          },
        ],
      ]),
    });
  });

  it("handles invlerp control with array channel (rank 1)", () => {
    const code = `
#uicontrol invlerp normalized(channel=[1])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT8, channelRank: 1 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "normalized",
          {
            type: "imageInvlerp",
            dataType: DataType.UINT8,
            clamp: true,
            default: {
              range: [0, 255],
              window: [0, 255],
              channel: [1],
            },
          },
        ],
      ]),
    });
  });

  it("handles invlerp control with array channel (rank 2)", () => {
    const code = `
#uicontrol invlerp normalized(channel=[1,2])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT8, channelRank: 2 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "normalized",
          {
            type: "imageInvlerp",
            dataType: DataType.UINT8,
            clamp: true,
            default: {
              range: [0, 255],
              window: [0, 255],
              channel: [1, 2],
            },
          },
        ],
      ]),
    });
  });

  it("handles property invlerp control without property", () => {
    const code = `
#uicontrol invlerp red
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const properties = new Map([
      ["p1", DataType.UINT8],
      ["p2", DataType.FLOAT32],
    ]);
    expect(
      parseShaderUiControls(code, {
        properties,
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "red",
          {
            type: "propertyInvlerp",
            properties,
            clamp: true,
            default: {
              range: undefined,
              window: undefined,
              dataType: DataType.UINT8,
              property: "p1",
            },
          },
        ],
      ]),
    });
  });

  it("handles property invlerp control with property", () => {
    const code = `
#uicontrol invlerp red(property="p2")
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const properties = new Map([
      ["p1", DataType.UINT8],
      ["p2", DataType.FLOAT32],
    ]);
    expect(
      parseShaderUiControls(code, {
        properties,
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "red",
          {
            type: "propertyInvlerp",
            properties,
            clamp: true,
            default: {
              range: undefined,
              window: undefined,
              dataType: DataType.FLOAT32,
              property: "p2",
            },
          },
        ],
      ]),
    });
  });

  it("handles property invlerp control with range", () => {
    const code = `
#uicontrol invlerp red(property="p2", range=[1, 10])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const properties = new Map([
      ["p1", DataType.UINT8],
      ["p2", DataType.FLOAT32],
    ]);
    expect(
      parseShaderUiControls(code, {
        properties,
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "red",
          {
            type: "propertyInvlerp",
            properties,
            clamp: true,
            default: {
              range: [1, 10],
              window: undefined,
              dataType: DataType.FLOAT32,
              property: "p2",
            },
          },
        ],
      ]),
    });
  });

  it("handles property invlerp control with window", () => {
    const code = `
#uicontrol invlerp red(property="p2", window=[1, 10])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const properties = new Map([
      ["p1", DataType.UINT8],
      ["p2", DataType.FLOAT32],
    ]);
    expect(
      parseShaderUiControls(code, {
        properties,
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "red",
          {
            type: "propertyInvlerp",
            properties,
            clamp: true,
            default: {
              range: undefined,
              window: [1, 10],
              dataType: DataType.FLOAT32,
              property: "p2",
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control without channel", () => {
    const code = `
#uicontrol transferFunction colormap(points=[])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT8, channelRank: 0 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "colormap",
          {
            type: "transferFunction",
            dataType: DataType.UINT8,
            default: {
              controlPoints: [],
              channel: [],
              color: vec3.fromValues(1, 1, 1),
              range: [0, 255],
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control without channel (rank 1)", () => {
    const code = `
#uicontrol transferFunction colormap(points=[])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT8, channelRank: 1 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "colormap",
          {
            type: "transferFunction",
            dataType: DataType.UINT8,
            default: {
              controlPoints: [],
              channel: [0],
              color: vec3.fromValues(1, 1, 1),
              range: [0, 255],
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control with channel (rank 0)", () => {
    const code = `
#uicontrol transferFunction colormap(points=[], channel=[])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT8, channelRank: 0 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "colormap",
          {
            type: "transferFunction",
            dataType: DataType.UINT8,
            default: {
              controlPoints: [],
              channel: [],
              color: vec3.fromValues(1, 1, 1),
              range: [0, 255],
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control with non-array channel (rank 1)", () => {
    const code = `
#uicontrol transferFunction colormap(points=[], channel=1)
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT8, channelRank: 1 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "colormap",
          {
            type: "transferFunction",
            dataType: DataType.UINT8,
            default: {
              controlPoints: [],
              channel: [1],
              color: vec3.fromValues(1, 1, 1),
              range: [0, 255],
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control with array channel (rank 1)", () => {
    const code = `
#uicontrol transferFunction colormap(points=[], channel=[1])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT8, channelRank: 1 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "colormap",
          {
            type: "transferFunction",
            dataType: DataType.UINT8,
            default: {
              controlPoints: [],
              channel: [1],
              color: vec3.fromValues(1, 1, 1),
              range: [0, 255],
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control with array channel (rank 2)", () => {
    const code = `
#uicontrol transferFunction colormap(points=[], channel=[1,2])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.FLOAT32, channelRank: 2 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "colormap",
          {
            type: "transferFunction",
            dataType: DataType.FLOAT32,
            default: {
              controlPoints: [],
              channel: [1, 2],
              color: vec3.fromValues(1, 1, 1),
              range: [0, 1],
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control with all properties non uint64 data", () => {
    const code = `
#uicontrol transferFunction colormap(points=[[200, "#00ff00", 0.1], [100, "#ff0000", 0.5], [0, "#000000", 0.0]], color="#0000ff", range=[0, 200], channel=[])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const maxTransferFunctionPoints = TRANSFER_FUNCTION_LENGTH - 1;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT32, channelRank: 0 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "colormap",
          {
            type: "transferFunction",
            dataType: DataType.UINT32,
            default: {
              controlPoints: [
                { position: 0, color: vec4.fromValues(0, 0, 0, 0) },
                {
                  position: Math.ceil(maxTransferFunctionPoints / 2),
                  color: vec4.fromValues(255, 0, 0, 128),
                },
                {
                  position: maxTransferFunctionPoints,
                  color: vec4.fromValues(0, 255, 0, 26),
                },
              ],
              channel: [],
              color: vec3.fromValues(0, 0, 1),
              range: [0, 200],
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control with all properties uint64 data", () => {
    const code = `
#uicontrol transferFunction colormap(points=[["18446744073709551615", "#00ff00", 0.1], ["9223372111111111111", "#ff0000", 0.5], ["0", "#000000", 0.0]], color="#0000ff", channel=[])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const maxTransferFunctionPoints = TRANSFER_FUNCTION_LENGTH - 1;
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT64, channelRank: 0 },
      }),
    ).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([
        [
          "colormap",
          {
            type: "transferFunction",
            dataType: DataType.UINT64,
            default: {
              controlPoints: [
                { position: 0, color: vec4.fromValues(0, 0, 0, 0) },
                {
                  position: Math.ceil(maxTransferFunctionPoints / 2),
                  color: vec4.fromValues(255, 0, 0, 128),
                },
                {
                  position: maxTransferFunctionPoints,
                  color: vec4.fromValues(0, 255, 0, 26),
                },
              ],
              channel: [],
              color: vec3.fromValues(0, 0, 1),
              range: defaultDataTypeRange[DataType.UINT64],
            },
          },
        ],
      ]),
    });
  });
});

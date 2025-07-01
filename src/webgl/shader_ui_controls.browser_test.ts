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

import { expect, describe, it } from "vitest";
import { DataType } from "#src/util/data_type.js";
import { vec3, vec4 } from "#src/util/geom.js";
import { defaultDataTypeRange } from "#src/util/lerp.js";
import {
  TrackableTransferFunctionParameters,
  parseShaderUiControls,
  parseTransferFunctionParameters,
  stripComments,
} from "#src/webgl/shader_ui_controls.js";
import type { TransferFunctionParameters } from "#src/widget/transfer_function.js";
import {
  ControlPoint,
  SortedControlPoints,
} from "#src/widget/transfer_function.js";

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
#uicontrol transferFunction colormap(controlPoints=[])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const range = defaultDataTypeRange[DataType.UINT8];
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
              sortedControlPoints: new SortedControlPoints([], DataType.UINT8),
              channel: [],
              defaultColor: vec3.fromValues(1, 1, 1),
              window: range,
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control without channel (rank 1)", () => {
    const code = `
#uicontrol transferFunction colormap(controlPoints=[])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const range = defaultDataTypeRange[DataType.UINT16];
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.UINT16, channelRank: 1 },
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
            dataType: DataType.UINT16,
            default: {
              sortedControlPoints: new SortedControlPoints([], DataType.UINT16),
              channel: [0],
              defaultColor: vec3.fromValues(1, 1, 1),
              window: range,
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control with channel (rank 0)", () => {
    const code = `
#uicontrol transferFunction colormap(controlPoints=[], channel=[])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const range = defaultDataTypeRange[DataType.UINT64];
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
              sortedControlPoints: new SortedControlPoints([], DataType.UINT64),
              channel: [],
              defaultColor: vec3.fromValues(1, 1, 1),
              window: range,
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control with non-array channel (rank 1)", () => {
    const code = `
#uicontrol transferFunction colormap(controlPoints=[], channel=1)
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const range = defaultDataTypeRange[DataType.FLOAT32];
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.FLOAT32, channelRank: 1 },
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
              sortedControlPoints: new SortedControlPoints(
                [],
                DataType.FLOAT32,
              ),
              channel: [1],
              defaultColor: vec3.fromValues(1, 1, 1),
              window: range,
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control with array channel (rank 1)", () => {
    const code = `
#uicontrol transferFunction colormap(controlPoints=[], channel=[1])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const range = defaultDataTypeRange[DataType.FLOAT32];
    expect(
      parseShaderUiControls(code, {
        imageData: { dataType: DataType.FLOAT32, channelRank: 1 },
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
              sortedControlPoints: new SortedControlPoints(
                [],
                DataType.FLOAT32,
              ),
              channel: [1],
              defaultColor: vec3.fromValues(1, 1, 1),
              window: range,
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control with array channel (rank 2)", () => {
    const code = `
#uicontrol transferFunction colormap(controlPoints=[], channel=[1,2])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const range = defaultDataTypeRange[DataType.FLOAT32];
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
              sortedControlPoints: new SortedControlPoints(
                [],
                DataType.FLOAT32,
              ),
              channel: [1, 2],
              defaultColor: vec3.fromValues(1, 1, 1),
              window: range,
            },
          },
        ],
      ]),
    });
  });
  it("handles transfer function control with all properties non uint64 data", () => {
    const code = `
#uicontrol transferFunction colormap(controlPoints=[[200, "#00ff00", 0.1], [100, "#ff0000", 0.5], [0, "#000000", 0.0]], defaultColor="#0000ff", window=[0, 1000], channel=[])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const controlPoints = [
      new ControlPoint(0, vec4.fromValues(0, 0, 0, 0)),
      new ControlPoint(200, vec4.fromValues(0, 255, 0, 26)),
      new ControlPoint(100, vec4.fromValues(255, 0, 0, 128)),
    ];
    const sortedControlPoints = new SortedControlPoints(
      controlPoints,
      DataType.UINT32,
    );
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
              sortedControlPoints,
              channel: [],
              defaultColor: vec3.fromValues(0, 0, 1),
              window: [0, 1000],
            },
          },
        ],
      ]),
    });
    expect(sortedControlPoints.range).toEqual([0, 200]);
  });
  it("handles transfer function control with all properties uint64 data", () => {
    const code = `
#uicontrol transferFunction colormap(controlPoints=[["18446744073709551615", "#00ff00", 0.1], ["9223372111111111111", "#ff0000", 0.5], [0, "#000000", 0.0]], defaultColor="#0000ff", channel=[], window=[0, 2000])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const controlPoints = [
      new ControlPoint(9223372111111111111n, vec4.fromValues(255, 0, 0, 128)),
      new ControlPoint(0n, vec4.fromValues(0, 0, 0, 0)),
      new ControlPoint(18446744073709551615n, vec4.fromValues(0, 255, 0, 26)),
    ];
    const sortedControlPoints = new SortedControlPoints(
      controlPoints,
      DataType.UINT64,
    );
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
              sortedControlPoints: sortedControlPoints,
              channel: [],
              defaultColor: vec3.fromValues(0, 0, 1),
<<<<<<< HEAD
              window: [0n, 2000n],
=======
              window: [Uint64.fromNumber(0), Uint64.fromNumber(2000)],
>>>>>>> 0aacf094 (Ichnaea working code on top of v2.40.1)
            },
          },
        ],
      ]),
    });
  });
});

describe("parseTransferFunctionParameters", () => {
  it("parses transfer function from JSON", () => {
    const code = `
#uicontrol transferFunction tf
void main() {
}
`;
    const parsed_val = parseShaderUiControls(code, {
      imageData: { dataType: DataType.UINT8, channelRank: 0 },
    });
    const default_val = parsed_val.controls.get("tf")!.default;
    const json = {
      controlPoints: [
        [150, "#ffffff", 1],
        [0, "#000000", 0],
      ],
      defaultColor: "#ff0000",
      window: [0, 200],
    };
    const parsed = parseTransferFunctionParameters(
      json,
      DataType.UINT8,
      default_val as TransferFunctionParameters,
    );
    expect(parsed).toEqual({
      sortedControlPoints: new SortedControlPoints(
        [
          new ControlPoint(0, vec4.fromValues(0, 0, 0, 0)),
          new ControlPoint(150, vec4.fromValues(255, 255, 255, 255)),
        ],
        DataType.UINT8,
      ),
      channel: [],
      defaultColor: vec3.fromValues(1, 0, 0),
      window: [0, 200],
    });
  });
  it("writes transfer function to JSON and detects changes from default", () => {
    const code = `
#uicontrol transferFunction tf
void main() {
}
`;
    const parsed_val = parseShaderUiControls(code, {
      imageData: { dataType: DataType.UINT64, channelRank: 0 },
    });
    const default_val = parsed_val.controls.get("tf")!
      .default as TransferFunctionParameters;
    const transferFunctionParameters = new TrackableTransferFunctionParameters(
      DataType.UINT64,
      default_val,
    );
    expect(transferFunctionParameters.toJSON()).toEqual(undefined);

    // Test setting a new control point
    const sortedControlPoints = new SortedControlPoints(
      [
        new ControlPoint(0n, vec4.fromValues(0, 0, 0, 10)),
        new ControlPoint(
          18446744073709551615n,
          vec4.fromValues(255, 255, 255, 255),
        ),
      ],
      DataType.UINT64,
    );
    transferFunctionParameters.value = {
      ...default_val,
      sortedControlPoints,
    };
    expect(transferFunctionParameters.toJSON()).toEqual({
      channel: undefined,
      defaultColor: undefined,
      window: undefined,
      controlPoints: [
        ["0", "#000000", 0.0392156862745098],
        ["18446744073709551615", "#ffffff", 1],
      ],
    });

    // Test setting a new default color
    transferFunctionParameters.value = {
      ...default_val,
      defaultColor: vec3.fromValues(0, 1, 0),
    };
    expect(transferFunctionParameters.toJSON()).toEqual({
      channel: undefined,
      defaultColor: "#00ff00",
      window: undefined,
      controlPoints: undefined,
    });

    // Test setting a new window
    transferFunctionParameters.value = {
      ...default_val,
      window: [0, 1000],
    };
    expect(transferFunctionParameters.toJSON()).toEqual({
      channel: undefined,
      defaultColor: undefined,
      window: ["0", "1000"],
      controlPoints: undefined,
    });

    // Test setting a new channel
    transferFunctionParameters.value = {
      ...default_val,
      channel: [1],
    };
    expect(transferFunctionParameters.toJSON()).toEqual({
      channel: [1],
      defaultColor: undefined,
      window: undefined,
      controlPoints: undefined,
    });
  });
});

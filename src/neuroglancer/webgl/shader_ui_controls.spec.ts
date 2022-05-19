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

import {DataType} from 'neuroglancer/util/data_type';
import {vec3} from 'neuroglancer/util/geom';
import {parseShaderUiControls, stripComments} from 'neuroglancer/webgl/shader_ui_controls';

describe('stripComments', () => {
  it('handles code without comments', () => {
    const code = `int val;
void main() {
  int val2;
  int val2 = "string literal // here";
}
`;
    expect(stripComments(code)).toEqual(code);
  });

  it('handles // comments', () => {
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

  it('handles /* comments', () => {
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

describe('parseShaderUiControls', () => {
  it('handles no controls', () => {
    const code = `
void main() {
  emitRGB(vec3(1.0, 1.0, 1.0));
}
`;
    expect(parseShaderUiControls(code))
        .toEqual({source: code, code, errors: [], controls: new Map()});
  });

  it('handles slider control', () => {
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
      controls: new Map([[
        'brightness', {type: 'slider', valueType: 'float', min: 0, max: 1, default: 0.5, step: 0.01}
      ]])
    });
  });

  it('handles checkbox control', () => {
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
        ['myCheckbox', {type: 'checkbox', valueType: 'bool', default: false}],
        ['myCheckbox2', {type: 'checkbox', valueType: 'bool', default: true}],
      ]),
    });
  });

  it('handles color control', () => {
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
      controls: new Map([[
        'color',
        {type: 'color', valueType: 'vec3', default: vec3.fromValues(1, 0, 0), defaultString: 'red'}
      ]])
    });
  });

  it('handles invlerp control without channel', () => {
    const code = `
#uicontrol invlerp normalized
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(parseShaderUiControls(code, {
      imageData: {dataType: DataType.UINT8, channelRank: 0}
    })).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([[
        'normalized', {
          type: 'imageInvlerp',
          dataType: DataType.UINT8,
          clamp: true,
          default: {
            range: [0, 255],
            window: [0, 255],
            channel: [],
          },
        }
      ]]),
    });
  });

  it('handles invlerp control without channel (rank 1)', () => {
    const code = `
#uicontrol invlerp normalized
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(parseShaderUiControls(code, {
      imageData: {dataType: DataType.UINT8, channelRank: 1}
    })).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([[
        'normalized', {
          type: 'imageInvlerp',
          dataType: DataType.UINT8,
          clamp: true,
          default: {
            range: [0, 255],
            window: [0, 255],
            channel: [0],
          },
        }
      ]]),
    });
  });

  it('handles invlerp control with channel (rank 0)', () => {
    const code = `
#uicontrol invlerp normalized(channel=[])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(parseShaderUiControls(code, {
      imageData: {dataType: DataType.UINT8, channelRank: 0}
    })).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([[
        'normalized', {
          type: 'imageInvlerp',
          dataType: DataType.UINT8,
          clamp: true,
          default: {
            range: [0, 255],
            window: [0, 255],
            channel: [],
          },
        }
      ]]),
    });
  });

  it('handles invlerp control with non-array channel (rank 1)', () => {
    const code = `
#uicontrol invlerp normalized(channel=1)
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(parseShaderUiControls(code, {
      imageData: {dataType: DataType.UINT8, channelRank: 1}
    })).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([[
        'normalized', {
          type: 'imageInvlerp',
          dataType: DataType.UINT8,
          clamp: true,
          default: {
            range: [0, 255],
            window: [0, 255],
            channel: [1],
          },
        }
      ]]),
    });
  });

  it('handles invlerp control with array channel (rank 1)', () => {
    const code = `
#uicontrol invlerp normalized(channel=[1])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(parseShaderUiControls(code, {
      imageData: {dataType: DataType.UINT8, channelRank: 1}
    })).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([[
        'normalized', {
          type: 'imageInvlerp',
          dataType: DataType.UINT8,
          clamp: true,
          default: {
            range: [0, 255],
            window: [0, 255],
            channel: [1],
          },
        }
      ]]),
    });
  });

  it('handles invlerp control with array channel (rank 2)', () => {
    const code = `
#uicontrol invlerp normalized(channel=[1,2])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    expect(parseShaderUiControls(code, {
      imageData: {dataType: DataType.UINT8, channelRank: 2}
    })).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([[
        'normalized', {
          type: 'imageInvlerp',
          dataType: DataType.UINT8,
          clamp: true,
          default: {
            range: [0, 255],
            window: [0, 255],
            channel: [1, 2],
          },
        }
      ]]),
    });
  });

  it('handles property invlerp control without property', () => {
    const code = `
#uicontrol invlerp red
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const properties = new Map([['p1', DataType.UINT8], ['p2', DataType.FLOAT32]]);
    expect(parseShaderUiControls(code, {
      properties
    })).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([[
        'red', {
          type: 'propertyInvlerp',
          properties,
          clamp: true,
          default: {
            range: undefined,
            window: undefined,
            dataType: DataType.UINT8,
            property: "p1",
          },
        }
      ]]),
    });
  });

  it('handles property invlerp control with property', () => {
    const code = `
#uicontrol invlerp red(property="p2")
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const properties = new Map([['p1', DataType.UINT8], ['p2', DataType.FLOAT32]]);
    expect(parseShaderUiControls(code, {
      properties
    })).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([[
        'red', {
          type: 'propertyInvlerp',
          properties,
          clamp: true,
          default: {
            range: undefined,
            window: undefined,
            dataType: DataType.FLOAT32,
            property: "p2",
          },
        }
      ]]),
    });
  });

  it('handles property invlerp control with range', () => {
    const code = `
#uicontrol invlerp red(property="p2", range=[1, 10])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const properties = new Map([['p1', DataType.UINT8], ['p2', DataType.FLOAT32]]);
    expect(parseShaderUiControls(code, {
      properties
    })).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([[
        'red', {
          type: 'propertyInvlerp',
          properties,
          clamp: true,
          default: {
            range: [1, 10],
            window: undefined,
            dataType: DataType.FLOAT32,
            property: "p2",
          },
        }
      ]]),
    });
  });

  it('handles property invlerp control with window', () => {
    const code = `
#uicontrol invlerp red(property="p2", window=[1, 10])
void main() {
}
`;
    const newCode = `

void main() {
}
`;
    const properties = new Map([['p1', DataType.UINT8], ['p2', DataType.FLOAT32]]);
    expect(parseShaderUiControls(code, {
      properties
    })).toEqual({
      source: code,
      code: newCode,
      errors: [],
      controls: new Map([[
        'red', {
          type: 'propertyInvlerp',
          properties,
          clamp: true,
          default: {
            range: undefined,
            window: [1, 10],
            dataType: DataType.FLOAT32,
            property: "p2",
          },
        }
      ]]),
    });
  });
});

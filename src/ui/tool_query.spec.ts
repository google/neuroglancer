import { describe, test, expect } from "vitest";
import {
  getCompletionOffset,
  getQueryTermToComplete,
  parsePartialToolQuery,
  parseToolQuery,
} from "#src/ui/tool_query.js";

describe("parseQuery", () => {
  test("simple term", () => {
    expect(parseToolQuery("type:shaderControl")).toMatchInlineSnapshot(`
      {
        "query": {
          "clauses": [
            {
              "include": true,
              "range": {
                "begin": 0,
                "end": 18,
              },
              "terms": [
                {
                  "predicate": {
                    "equals": "shaderControl",
                  },
                  "property": "type",
                  "range": {
                    "begin": 0,
                    "end": 18,
                  },
                },
              ],
            },
          ],
        },
      }
    `);
  });

  test("multiple terms", () => {
    expect(parseToolQuery("+type:shaderControl layer:image"))
      .toMatchInlineSnapshot(`
        {
          "query": {
            "clauses": [
              {
                "include": true,
                "range": {
                  "begin": 0,
                  "end": 31,
                },
                "terms": [
                  {
                    "predicate": {
                      "equals": "shaderControl",
                    },
                    "property": "type",
                    "range": {
                      "begin": 1,
                      "end": 19,
                    },
                  },
                  {
                    "predicate": {
                      "equals": "image",
                    },
                    "property": "layer",
                    "range": {
                      "begin": 20,
                      "end": 31,
                    },
                  },
                ],
              },
            ],
          },
        }
      `);
  });

  test("multiple clauses", () => {
    expect(parseToolQuery("+type:shaderControl -layer:image"))
      .toMatchInlineSnapshot(`
        {
          "query": {
            "clauses": [
              {
                "include": true,
                "range": {
                  "begin": 0,
                  "end": 19,
                },
                "terms": [
                  {
                    "predicate": {
                      "equals": "shaderControl",
                    },
                    "property": "type",
                    "range": {
                      "begin": 1,
                      "end": 19,
                    },
                  },
                ],
              },
              {
                "include": false,
                "range": {
                  "begin": 20,
                  "end": 32,
                },
                "terms": [
                  {
                    "predicate": {
                      "equals": "image",
                    },
                    "property": "layer",
                    "range": {
                      "begin": 21,
                      "end": 32,
                    },
                  },
                ],
              },
            ],
          },
        }
      `);
  });

  test("quoted value", () => {
    expect(parseToolQuery(`type:"shaderControl"`)).toMatchInlineSnapshot(`
      {
        "query": {
          "clauses": [
            {
              "include": true,
              "range": {
                "begin": 0,
                "end": 20,
              },
              "terms": [
                {
                  "predicate": {
                    "equals": "shaderControl",
                  },
                  "property": "type",
                  "range": {
                    "begin": 0,
                    "end": 20,
                  },
                },
              ],
            },
          ],
        },
      }
    `);
  });

  test("regexp value", () => {
    expect(parseToolQuery(`type:/shaderControl/`)).toMatchInlineSnapshot(`
      {
        "query": {
          "clauses": [
            {
              "include": true,
              "range": {
                "begin": 0,
                "end": 20,
              },
              "terms": [
                {
                  "predicate": {
                    "regexp": /shaderControl/i,
                  },
                  "property": "type",
                  "range": {
                    "begin": 0,
                    "end": 20,
                  },
                },
              ],
            },
          ],
        },
      }
    `);
  });

  test("invalid term", () => {
    expect(parseToolQuery(`a`)).toMatchInlineSnapshot(`
      {
        "errors": [
          {
            "message": "Invalid clause/term",
            "range": {
              "begin": 0,
              "end": 1,
            },
          },
        ],
      }
    `);
  });

  test("empty clause", () => {
    expect(parseToolQuery(`+`)).toMatchInlineSnapshot(`
      {
        "query": {
          "clauses": [
            {
              "include": true,
              "range": {
                "begin": 0,
                "end": 1,
              },
              "terms": [],
            },
          ],
        },
      }
    `);
  });

  test("duplicate property", () => {
    expect(parseToolQuery("type:shaderControl type:shaderControl"))
      .toMatchInlineSnapshot(`
        {
          "errors": [
            {
              "message": "Property "type" cannot be constrained by more than one term in a clause",
              "range": {
                "begin": 19,
                "end": 23,
              },
            },
          ],
        }
      `);
  });
});

describe("getCompletionOffset", () => {
  test("property value", () => {
    expect(
      getCompletionOffset(parsePartialToolQuery("layerType:im")),
    ).toMatchInlineSnapshot(`0`);
  });
});

describe("getQueryTermToComplete", () => {
  test("property value", () => {
    expect(getQueryTermToComplete(parsePartialToolQuery("layerType:im")))
      .toMatchInlineSnapshot(`
        {
          "completionQuery": {
            "clauses": [
              {
                "include": true,
                "range": {
                  "begin": -1,
                  "end": -1,
                },
                "terms": [
                  {
                    "predicate": {
                      "regexp": /\\^im/,
                    },
                    "property": "layerType",
                    "range": {
                      "begin": -1,
                      "end": -1,
                    },
                  },
                ],
              },
            ],
          },
          "include": true,
          "offset": 10,
          "prefix": "im",
          "property": "layerType",
        }
      `);
  });

  test("property name after existing term", () => {
    expect(getQueryTermToComplete(parsePartialToolQuery("layerType:image j")))
      .toMatchInlineSnapshot(`
        {
          "completionQuery": {
            "clauses": [
              {
                "include": true,
                "range": {
                  "begin": -1,
                  "end": -1,
                },
                "terms": [
                  {
                    "predicate": {
                      "equals": "image",
                    },
                    "property": "layerType",
                    "range": {
                      "begin": 0,
                      "end": 15,
                    },
                  },
                ],
              },
            ],
          },
          "include": true,
          "offset": 16,
          "prefix": "j",
          "property": undefined,
        }
      `);
  });
});

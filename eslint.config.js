// @ts-check

import eslint from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";

const editQueueImportPatterns = [
  {
    group: ["./", "../"],
    message: "Relative imports are not allowed.",
  },
  {
    regex: "^(?:#src/|src/)datasource(?:/|$)",
    message:
      "Generic optimistic edit modules must not depend on datasource implementations.",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules",
      "**/dist",
      "**/python",
      "templates/neuroglancer/sliceview",
      "src/third_party/jpgjs/jpg.js",
      "**/templates",
      "**/build",
      "**/.tox",
      "**/.nox",
      "**/.venv",
      "lib",
      "**/python",
      "**/config",
      "**/typings",
      "src/mesh/draco/stub.js",
      "**/tsconfig.tsbuildinfo",
      "examples",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    settings: {
      "import/resolver": {
        typescript: {},
        node: {},
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-empty-interface": "off",

      "prefer-const": [
        "error",
        {
          destructuring: "all",
        },
      ],

      "no-constant-condition": "off",

      "no-unused-disable": "off",

      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      "@typescript-eslint/no-unsafe-function-type": "off",

      "no-unsafe-finally": "off",
      "require-yield": "off",
      "no-inner-declarations": "off",

      // Supported by oxlint
      "import/namespace": "off",
      "import/default": "off",

      "import/no-named-as-default": "off",
      "import/no-named-as-default-member": "off",
      "@typescript-eslint/consistent-type-imports": "error",
      "import/no-unresolved": "error",
      "import/no-extraneous-dependencies": "error",

      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal"],

          alphabetize: {
            order: "asc",
            orderImportKind: "asc",
          },
        },
      ],

      // Neuroglancer uses `varname;` to suppress unused parameter warnings.
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  {
    files: ["src/**/*"],

    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./", "../"],
              message: "Relative imports are not allowed.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/skeleton/edit_queue/**/*.ts"],

    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...editQueueImportPatterns,
            {
              regex: "^#src/skeleton/edit/",
              message:
                "The edit queue must not depend on the layer-facing edit code.",
            },
          ],
        },
      ],
    },
  },
  {
    // Specs may build their fixtures from the layer-facing edit code.
    files: ["src/skeleton/edit_queue/**/*.spec.ts"],

    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: editQueueImportPatterns,
        },
      ],
    },
  },
  {
    files: ["build_tools/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
    },
  },
);

import { readFile } from "fs/promises";
import type { FilterPattern } from "@rollup/pluginutils";
import { createFilter } from "@rollup/pluginutils";
import type { PluginContext } from "rollup";
import type { Plugin } from "vite";

export default (
  options: { include?: FilterPattern; exclude?: FilterPattern } = {},
): Plugin => {
  const { include, exclude } = options;
  const filter = createFilter(include, exclude);
  return {
    name: "neuroglancer:binary",
    async load(this: PluginContext, id: string) {
      if (id[0] === "\0") {
        // Ignore per rollup convention.
        return undefined;
      }
      const file = id.replace(/[?#].*$/, "");
      if (!filter(file)) return undefined;
      this.addWatchFile(file);
      const encoded = await readFile(file, { encoding: "base64" });
      const text = `
const s = atob(${JSON.stringify(encoded)});
const length = s.length;
const buffer = new Uint8Array(length);
for (let i = 0; i < length; ++i) {
  buffer[i] = s.charCodeAt(i);
}
export default buffer;
`;
      return text;
    },
  };
};

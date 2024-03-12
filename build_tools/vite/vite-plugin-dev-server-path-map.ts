import type { Plugin } from "vite";

export default (options: { map: Map<string, string> }): Plugin => {
  const { map } = options;
  return {
    name: "neuroglancer-dev-server-path-map",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const dest = map.get(req.url!);
        if (dest !== undefined) {
          req.url = dest;
          //req.path = dest;
        }
        next();
      });
    },
  };
};

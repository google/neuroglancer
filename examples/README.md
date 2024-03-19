This directory contains examples showing how to use Neuroglancer as a library in
a client-side web application.

WARNING: Neuroglancer does not yet offer any stability guarantees for the
JavaScript API.

Neuroglancer can be used as a dependency in two ways:

1. Installing directly from the Github repository, via:

   ```shell
   npm install google/neuroglancer
   ```

2. Linking to a local checkout of the Neuroglancer repository via:

   ```shell
   npm link neuroglancer
   ```

   or

   ```shell
   npm install file:/local/path/to/neuroglancer
   ```

   This may be useful when developing Neuroglancer locally. In this case the
   dependent project directly consumes the original TypeScript sources, and must
   be configured with appropriate transpilation support.

The following bundlers are known to be compatible:

- [webpack](./webpack/) (recommended)
- [parcel](./parcel/)
- [vite](./vite/)

esbuild is not compatible due to https://github.com/evanw/esbuild/issues/795

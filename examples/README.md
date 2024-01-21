This directory contains examples showing how to use Neuroglancer as a library in
a client-side web application.

WARNING: Neuroglancer does not yet offer any stability guarantees for the
JavaScript API.

Neuroglancer can be used as a dependency in three ways:

1. Installing the published npm package via:

   ```shell
   npm install neuroglancer
   ```

   This will use the built Neuroglancer package, with the TypeScript sources
   already transpiled to JavaScript. This is the normal, recommended way to use
   Neuroglancer and imposes the least requirements.

2. Installing directly from the Github repository, via:

   ```shell
   npm install google/neuroglancer
   ```

3. Linking to a local checkout of the Neuroglancer repository via:

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

- [vite](./vite/)
- [parcel](./parcel/)
- [webpack](./webpack/)

esbuild is not compatible due to https://github.com/evanw/esbuild/issues/795

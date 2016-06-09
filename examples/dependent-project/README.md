This example provides a template for making a package that depends on
neuroglancer.

It simply binds the `o` key to set the position to the origin.

# Setup

This project is set up to treat the `src/neuroglancer` directory of the
neuroglancer package as if it were a part of this package.  This is convenient
for simultaneous development of this project along with Neuroglancer, as it
allows standard TypeScript tooling to find definitions in Neuroglancer without
the need to regenerate `.d.ts` files.

In [tsconfig.json](tsconfig.json), we define two module resolution aliases:
- `neuroglancer/*` maps to `src/neuroglancer` in the Neuroglancer package;
- `my-neuroglancer-project/*` maps to `src/my-neuroglancer-project/*` in this package.

This allows any of the modules within this project to refer to other modules
using a project-relative path, as is done in neuroglancer.

The typings file in `typings/index.d.ts` currently just includes all of the
typings for Neuroglancer dependencies by reference.  If additional typings are
required, they can also be referenced from that file.

The symbolic link from `third_party/neuroglancer` with the path
`../node_modules/neuroglancer/src/neuroglancer` is a workaround for the lack of
support for more sophisticated exclusion rules in tools like `tsserver` (used
for editor integration).  It allows us to exclude `node_modules` but still
include the main neuroglancer source based on definitions in `tsconfig.json`.

# Building

1. If you would like this to depend on a local version of neuroglancer, you can use
   the standard `link` mechanism of npm:

   - From within the neuroglancer root directory, type:
     `npm link`
  
   - From within this directory, type:
     `npm link neuroglancer`

2. To install dependencies, run:
   `npm i`

3. To run the development server:
   `npm run dev-server`

4. To build minified output:
   `npm run build-min`

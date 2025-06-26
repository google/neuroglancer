// Note: this is hardcoded because the `async_computation.bundle.js` build
// artifact from neuroglancer will be copied by Hedwig's build process to the
// `static/js` directory and served from
// `/static/js/async_computation.bundle.js`. Hardcoding is needed because there
// is no other way to specify to Neuroglancer the path of this file after
// Hedwig's build:
export const asyncComputationWorkerFileName  = '/test-generated-files/async_computation.bundle.js';

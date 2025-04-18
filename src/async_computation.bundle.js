// Note: This file uses ".js" rather than ".ts" extension because we cannot rely
// on Node.js subpath imports to translate paths for Workers since those paths
// must be valid for use in `new URL` with multiple bundlers.
import "#src/util/polyfills.js";
import "#src/async_computation/encode_compressed_segmentation.js";
import "#src/datasource/enabled_async_computation_modules.js";
import "#src/kvstore/enabled_async_computation_modules.js";
import "#src/async_computation/handler.js";

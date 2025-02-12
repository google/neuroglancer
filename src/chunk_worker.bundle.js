// Note: This file uses ".js" rather than ".ts" extension because we cannot rely
// on Node.js subpath imports to translate paths for Workers since those paths
// must be valid for use in `new URL` with multiple bundlers.
import "#src/util/polyfills.js";
import "#src/shared_watchable_value.js";
import "#src/chunk_manager/backend.js";
import "#src/kvstore/backend.js";
import "#src/sliceview/backend.js";
import "#src/perspective_view/backend.js";
import "#src/volume_rendering/backend.js";
import "#src/annotation/backend.js";
import "#src/datasource/enabled_backend_modules.js";
import "#src/kvstore/enabled_backend_modules.js";
import "#src/worker_rpc_context.js";

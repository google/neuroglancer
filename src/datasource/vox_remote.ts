/**
 * @license
 * Copyright 2025.
 */

import {
  emptyValidCoordinateSpace,
  makeIdentityTransform,
} from "#src/coordinate_transform.js";
import type {
  CompleteUrlOptions,
  DataSource,
  DataSourceProvider,
  GetDataSourceOptions,
} from "#src/datasource/index.js";
import { getPrefixMatchesWithDescriptions } from "#src/util/completion.js";

/**
 * Provider for vox+http(s):// URLs used by the Vox layer to connect to a remote voxel server.
 *
 * Accepted forms:
 *   vox+http://host(:port)/(?token=TOKEN)
 *   vox+https://host(:port)/(?token=TOKEN)
 *
 * The DataSource returned is a minimal stub whose presence allows the Vox layer to detect
 * selection of a remote source. The actual data flow is handled by the Vox layer and
 * voxel_annotation chunk sources, which read the URL directly from the layer spec and pass
 * serverUrl/token to the worker.
 */
export class VoxRemoteDataSourceProvider implements DataSourceProvider {
  constructor(private readonly schemeName: "vox+http" | "vox+https") {}

  get scheme() {
    return this.schemeName;
  }

  get description() {
    return this.schemeName === "vox+http"
      ? "Vox remote server over HTTP"
      : "Vox remote server over HTTPS";
  }

  async get(options: GetDataSourceOptions): Promise<DataSource> {
    // Minimal identity transform; Vox layer supplies its own render transform.
    const modelTransform = makeIdentityTransform(emptyValidCoordinateSpace);
    return {
      modelTransform,
      canChangeModelSpaceRank: false,
      subsources: [
        {
          id: "default",
          default: true,
          // Leave `subsource` as an empty object to indicate a non-local provider.
          // The Vox layer will further validate the URL scheme.
          subsource: {},
        },
      ],
      // Preserve the canonical URL for later inspection by the layer.
      canonicalUrl: `${this.schemeName}://${options.providerUrl}`,
    };
  }

  async completeUrl(options: CompleteUrlOptions) {
    // Offer simple skeletons for host and optional token.
    // Completion UI will prefix with the full scheme automatically.
    const items = [
      {
        value: "",
        description: "Enter host[:port]/ optionally followed by ?token=...",
      },
      { value: "localhost:8080/", description: "Local development server" },
      { value: "example.com/", description: "Production server" },
      { value: "example.com/?token=", description: "With token parameter" },
    ];
    return {
      offset: 0,
      completions: getPrefixMatchesWithDescriptions(
        options.providerUrl,
        items,
        (x) => x.value,
        (x) => x.description,
      ),
    };
  }
}

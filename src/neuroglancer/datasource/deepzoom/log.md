# Deep Zoom support (2D pyramidal image, don't ask why people want it in Neuroglancer)

It's a tiled pyramidal image representation where pyramid levels always halve the width and height of the previous level, and then on each level the image is cut into equally sized square tiles. So it's very similar to the `precomputed` format without many of its complications. Thus the implementation is based on that one.

1. Minimal changes to list the new data source

* Made a copy of `precomputed`, becomes `deepzoom`.  
* Modified `register_defaults.ts` to add `deepzoom`.  
* List the datasource in `bundle-config.js` - copied the entire `precomputed` block and made its `source` refer the new folder.  

This last step needs restarting the `dev-server`. Of course the resulting `deepzoom://` still opens `precomputed` sets, which is a good thing, allows keeping open some dataset while cleaning up the unwanted features.

2. Big cleanup

For this step `bundle-config.js` was modified to contain `deepzoom` datasource only, and `precomputed` was physically moved away (also `graphene`, because of its imports). Feature removal steps can be conveniently started in `base.ts`, then the error messages can be followed about missing things, and unused imports.

2. 1. Fix `import`s

Trivial step, making the code build again.

2. 2. Removals

Unwanted features, like annotation, mesh, segmentation, sharding, and skeleton support.  
There were some commented code blocks (coming from the original repo), those are removed too.

2. 3. Further removals

Unwanted encoding schemes (raw kept for testing, jpg and png for planned future use).  
`export`s keep all dead code alive, commented the fake ones.  
Further feature removal with text search (traces of "mesh", "skeleton", and "segment").  
`precomputed` renamed to `deepzoom`, also inside strings (related to RPC and memoizing features).

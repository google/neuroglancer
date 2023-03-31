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

2. 4. Further renamings

In local identifiers: `volume` to `image`, `chunk` to `tile`, `multiscale` to `pyramidal`. Now it's easier to track what is owned versus what is imported. Also, identifiers are distinct enough that they're unlikely clash with anything else, so other data sources have been restored at this point (not seen in the commit, as removal was done locally too).

Supposedly this is the last point where `deepzoom` data source still opens `precomputed`, but only "classic" raster data, and only with `raw`, `jpeg`, or `png` encodings.

3. First working version

DZI descriptor is parsed, and used to fake the array of `ScaleInfo` structure. A simple backend hack is employed, skipping all the magic with partial chunks, but using [`createImageBitmap()`](https://developer.mozilla.org/en-US/docs/Web/API/createImageBitmap) (with a `Blob` in particular) for decoding the tile and [`OffscreenCanvas`](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas) for making it fixed size and also trimming the overlay (Deep Zoom tiles are allowed to have overlay with their neighbors for dubious reasons).  
`OffscreenCanvas` needs relatively recent Firefox (105, 2022-09-20), and brand new Safari (16.4, 2023-03-27 - which was 4 days ago at the time of writing).  
`raw` encoding is removed now. While `createImageBitmap()` could handle whatever image format the browser supports, the filtering is kept in place and `png`, `jpeg`, and `jpg` formats are accepted only.

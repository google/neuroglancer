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

4. Compatibility version

This one works on older Firefox and Safari versions.  

The built-in `png` and `jpeg` decoders are brought into action. As there are known Deep Zoom tile generators putting an extra `overlay` pixel row on right/bottom edge tiles, the specify-image-dimensions-beforehand requirement is solved with actually reading into the files (`PNG` has its dimensions at fixed positions, and in case of `JPEG` the first occurrence of a `SIFn` chunk is assumed to tell the full dimensions).  
Extra quirk is that the `JPEG` decoder produces planar image (there is an explicit `transposeArray2d()` call for that in `decode_jpeg.ts`), while `PNG` returns packed (like `getImageData()` in the previous variant).

5. Formatting, and an `export`

Gulp is somewhat happy now.  
Side note: it reformatted 178 files, 2 of them being mine (`base.ts` and `register_defaults.ts` were untouched).  

`backend.ts`:

* it wanted to add an extra empty line after `import`s, I'm not sure about that
* it wanted to reformat the simple/future tile loader (`OffscreenCanvas` and co.) in the comment, that doesn't make sense
* I personally prefer keeping `requestAsyncComputation()` parameters in their current form: the first line is for the RPC call (function, token, transferrables), and the second line is for the actual call parameters.

`frontend.ts`:

* I think it's fully gulp-accepted now (moved a single comment around after the change)
* 3 utility functions are removed and `imported` from `precomupted` instead. One of them was not `export`ed, now it is. These may be good candidates to be collected at some completely different location anyway, with other utility functions.

Random things:

* Noticed the latest feature addition, the "hidden placeholder resolution" thing. It's not in use by this datasource yet, but definitely something to look into
* While I needed the name distinctions to have a better track of what's local and what's imported, on a longer run it may be possible the inherit from `precomputed` (instead of what's happened here, so making a copy of it)
* Configured fragment with PNG tiles, hosted on cscs.ch: `#!%7B"dimensions":%7B"x":%5B1e-9%2C"m"%5D%2C"y":%5B1e-9%2C"m"%5D%2C"z":%5B1e-9%2C"m"%5D%7D%2C"position":%5B11285.9521484375%2C8724.158203125%2C0.5%5D%2C"crossSectionScale":22.759895093526723%2C"projectionScale":32768%2C"layers":%5B%7B"type":"image"%2C"source":"deepzoom://https://object.cscs.ch/v1/AUTH_08c08f9f119744cbbf77e216988da3eb/imgsvc-c304a135-4558-4765-bd52-35452db90dce/hbp-00169_482_R602_1961__BDA_s160.tif/hbp-00169_482_R602_1961__BDA_s160.dzi"%2C"tab":"rendering"%2C"shader":"#uicontrol%20invlerp%20normalized%5Cnvoid%20main%20%28%29%20%7B%5Cn%20%20emitRGB%28vec3%28toNormalized%28getDataValue%280%29%29%2C%5Cn%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20toNormalized%28getDataValue%281%29%29%2C%5Cn%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20toNormalized%28getDataValue%282%29%29%29%29%3B%5Cn%7D"%2C"channelDimensions":%7B"c%5E":%5B1%2C""%5D%7D%2C"name":"hbp-00169_482_R602_1961__BDA_s160.dzi"%7D%5D%2C"selectedLayer":%7B"visible":true%2C"layer":"hbp-00169_482_R602_1961__BDA_s160.dzi"%7D%2C"layout":"xy"%7D`
* Configured fragment with JPG tiles, hosted on cscs.ch again, but accessed via data-proxy.ebrains.eu: `#!%7B"dimensions":%7B"x":%5B1e-9%2C"m"%5D%2C"y":%5B1e-9%2C"m"%5D%2C"z":%5B1e-9%2C"m"%5D%7D%2C"position":%5B24468.66796875%2C17203.955078125%2C0.5%5D%2C"crossSectionScale":42.52108200006277%2C"projectionScale":8192%2C"layers":%5B%7B"type":"image"%2C"source":"deepzoom://https://data-proxy.ebrains.eu/api/v1/buckets/localizoom/14122_mPPC_BDA_s186.tif/14122_mPPC_BDA_s186.dzi"%2C"tab":"rendering"%2C"shader":"#uicontrol%20invlerp%20normalized%5Cnvoid%20main%20%28%29%20%7B%5Cn%20%20emitRGB%28vec3%28toNormalized%28getDataValue%280%29%29%2C%5Cn%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20toNormalized%28getDataValue%281%29%29%2C%5Cn%20%20%20%20%20%20%20%20%20%20%20%20%20%20%20toNormalized%28getDataValue%282%29%29%29%29%3B%5Cn%7D%5Cn"%2C"channelDimensions":%7B"c%5E":%5B1%2C""%5D%7D%2C"name":"class_0"%7D%5D%2C"selectedLayer":%7B"visible":true%2C"layer":"class_0"%7D%2C"layout":"xy"%7D`

6. Trivial housekeeping

Unused decoders are removed from `bundle-config.js`, formatting a single code block, providing links to documentation and software.

7. Image parsing hacks removed

PNG/JPEG decoders can still verify expected dimensions, but they also accept `undefined` now. Returned `Uint8Array` is replaced with `DecodedImage` now, containing the array, width, height, and the number of components/channels.

8. `LevelInfo`, `encoding`, `format`

`ScaleInfo` emulation is scattered, a `LevelInfo` remains with `width` and `height` only, everything else is constant for all levels and provided directly at their site of usage.  
Besides `encoding` being a single dataset-level property now, `format` is preserved separately, so file extension of tiles keeps its case in case-sensitive environments.

9. Minor pre-breakage step

`LowerBound` things removed, they default to 0.  
`'z'` is a space now (index -2- appears for empty string), and unitless. `1e-9` scale kept, no "infinity" stretch occurs yet.  
An `if (rank === 4)` check removed, `rank` is hardcoded 4 at this step.  
So image is still 3D, with a thickness of a single voxel.

10. Dropping `z`

Data source is 2D now (+colors). `xy` view functions, `xz` view shows infinite stretch along the `z` axis, `yz` view is broken completely (but comes alive when adding a fake dimension with the "+v" button).  


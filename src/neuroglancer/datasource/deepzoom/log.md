# Deep Zoom support (2D pyramidal image, don't ask why people want it in Neuroglancer)

It's a tiled pyramidal image representation where pyramid levels always halve the width and height of the previous level, and then on each level the image is cut into equally sized square tiles. So it's very similar to the `precomputed` format without many of its complications. Thus the implementation is based on that one.

1. Minimal changes to list the new data source

* Made a copy of `precomputed`, becomes `deepzoom`.  
* Modified `register_defaults.ts` to add `deepzoom`.  
* List the datasource in `bundle-config.js` - copied the entire `precomputed` block and made its `source` refer the new folder.  

This last step needs restarting the `dev-server`. Of course the resulting `deepzoom://` still opens `precomputed` sets, which is a good thing, allows keeping open some dataset while cleaning up the unwanted features.


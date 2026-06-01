# colormaps.zarr

Zarr v3 array of shape `(N, 256, 3)`, dtype `uint8`. Each slice
`colormaps[i, :, :]` is the 256-entry RGB lookup table for the colormap
named `attributes["colormap_names"][i]` (this list MUST match
`COLORMAP_BIN_NAMES` in `../colormaps.ts`).

The array uses the Zarr v3 `sharding_indexed` codec: all N logical chunks
(one per colormap, sub-chunk shape `(1, 256, 3)`) live in a single
physical shard file at `c/0/0/0`. The shard's trailing index makes
per-colormap fetches possible via HTTP Range requests against that single
file — the JS loader downloads only the colormap(s) the user actually
needs, not the whole table.

Regenerate with:

```sh
uv run --no-project build_tools/generate_colormaps_zarr.py
```

CI does not run the regenerator; this directory is committed.

External tools can open the array via any standard Zarr v3 reader, e.g.

```python
import tensorstore as ts
t = ts.open({"driver": "zarr3",
             "kvstore": {"driver": "file", "path": "src/webgl/colormaps.zarr/"}}).result()
print(t.shape, t.dtype, t.spec().to_json()["metadata"]["attributes"]["colormap_names"])
# Read just one colormap:
viridis = t[1].read().result()  # 256x3 uint8
```

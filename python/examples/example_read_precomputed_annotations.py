import neuroglancer.read_precomputed_annotations

reader = neuroglancer.read_precomputed_annotations.AnnotationReader(
    "gs://h01-release/data/20210601/c2/synapses/precomputed/"
)

print(
    list(
        reader.get_within_spatial_bounds(
            limit=1000,
            lower_bound=[70258.0, 115184.0, 1892.0],
            upper_bound=[70258.0, 115184.0, 1892.0],
        )
    )
)

ann = reader.by_id[80647151]
print(ann)

for i, key in enumerate(reader.relationships):
    for segment in ann.segments[i]:
        related_anns = reader.relationships[key][segment]
        print(related_anns)

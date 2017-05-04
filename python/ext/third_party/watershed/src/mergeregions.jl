using DataStructures

export mergeregions!

"""
`MERGEREGIONS` - merge small regions by agglomerative clustering

    new_rg = mergeregions(seg, rg, counts, thresholds, dust_size = 0)

* `seg` - segmentation.  IDs of foreground regions are 1:length(counts).  ID=0 for background.  This is modified in place by the clustering.
* `rg`: region graph as list of edges, array of (weight,id1,id2) tuples. The edges should be presorted so that weights are in descending order. Region IDs should be consistent with those in `seg`, except no zeros.
* `new_rg`: new region graph after clustering, same format as `rg`.
* `counts`: sizes of regions in `seg` (modified in place)
* `thresholds`: sequence of (size_th,weight_th) pairs to be used for merging
* `dust_size`: after merging, tiny regions less than dust_size to be eliminated by changing them to background voxels

Agglomerative clustering proceeds by considering the edges of the region graph in sequence.  If either region has size less than `size_th`, then merge the regions. When the weight of the edge in the region graph is less than or equal to `weight_th`, agglomeration proceeds to the next `(size_th,weight_th)` in `thresholds` or terminates if there is none.
"""

# to-do: update code to include self-edges in `new_rg`
function mergeregions!{T,N}(seg::Array{T,N}, rg, counts, thresholds, dust_size = 0)
    sets = IntDisjointSets(length(counts))
    ZERO = convert(T,0)
    ONE  = convert(T,1)
    for (size_th,weight_th) in thresholds
        for (weight,id1,id2) in rg
            s1 = find_root(sets,id1)
            s2 = find_root(sets,id2)
            if (weight > weight_th) && (s1 != s2)
                if ( (counts[s1] < size_th) || (counts[s2] < size_th) )
                    counts[s1] += counts[s2]
                    counts[s2]  = ZERO
                    union!(sets,s1,s2)
                    s = find_root(sets,s1)   # this is either s1 or s2
                    (counts[s], counts[s1]) = (counts[s1], counts[s])
                end
            end
        end
    end
    println("Done with merging")

    # define mapping from parents to new segment IDs
    # and apply to redefine counts
    remaps = zeros(T,length(counts))     # generalize to include UInt64
    next_id = ONE
    for id = ONE:UInt32(length(counts))
        s = find_root(sets,id)
        if ( (remaps[s] == ZERO) && (counts[s] >= dust_size) )
            remaps[s] = next_id
            counts[next_id] = counts[s]    # exercise: prove that next_id < counts
            next_id += ONE
        end
    end
    resize!(counts,next_id-ONE)

    # apply remapping to voxels in seg
    # note that dust regions will get assigned to background
    for idx in eachindex(seg)
        if seg[idx] !=ZERO    # only foreground voxels
            seg[idx] = remaps[find_root(sets,seg[idx])]
        end
    end
    println("Done with remapping, total: ", (next_id-ONE), " regions")

    # apply remapping to region graph
    in_rg = [Set{UInt32}() for i=ONE:next_id-ONE]
    new_rg = Array{Tuple{Float64,UInt32,UInt32},1}(0)
    for (weight, id1, id2) in rg
        s1 = remaps[find_root(sets,id1)]
        s2 = remaps[find_root(sets,id2)]
        if ( s1 != s2 && s1 !=ZERO && s2 !=ZERO)  # ignore dust regions
            (s1,s2) = minmax(s1,s2)
            if ~in(s2,in_rg[s1])
                push!(new_rg,(weight, s1, s2))
                push!(in_rg[s1],s2)
            end
        end
    end

    println("Done with updating the region graph, size: ", length(new_rg))
    return new_rg
end

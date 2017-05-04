export findbasins, findbasins!

"""
`FINDBASINS` - find basins of attraction

     seg, counts, counts0 = findbasins(sag)

* `sag`: steepest ascent graph (directed and unweighted). `sag[x,y,z]` contains 6-bit number encoding edges outgoing from (x,y,z)
* `seg`: segmentation into basins.  Each element of the 3D array contains a *basin ID*, a nonnegative integer ranging from 0 to the number of basins.
* `counts`: number of voxels in each basin
* `counts0`: number of background voxels

A value of 0 in `seg` indicates a background voxel, which has no edges
at all in the steepest ascent graph.  All such singletons are given
the same ID of 0, although they are technically basins by themselves.

The algorithm starts from an unassigned voxel, and identifies all
downstream voxels via breadth-first search (BFS). The search
terminates in two possible ways:

1. downstream voxel that was previously assigned a basin ID =>
assign that ID to queued voxels.
2. no more downstream voxels => assign new basin ID to queued voxels.

Then the queue is emptied, and BFS begins anew at an unassigned voxel.
The algorithm ends when all voxels are assigned.

The 7th bit (0x40) is used to indicate whether a voxel has been
visited during BFS.

The MSB indicates whether a voxel has been assigned a basin ID.  The MSB definition is given in the functions at the end of the file for UInt32 and UInt64 cases.

`findbasins` is applied to the steepest ascent graph after modification by `divideplateaus!`  By this point all paths are unique, except in maximal plateaus.
"""

# what happens if `findbasins` is applied directly to the output of `steepestascent`?  ties are resolved in an unsystematic way.  seems to differ from Cousty's watershed cuts, which alternates btw DFS and BFS.

function findbasins{T}(sag::Array{T,3})
    seg = copy(sag)
    (seg, counts, counts0) = findbasins!(seg)
    return (seg, counts, counts0)
end

# in-place version
function findbasins!{T}(seg::Array{T,3})
    # seg initially contains the steepest ascent graph
    # and is transformed in-place to yield the segmentation into basins
    (xdim,ydim,zdim) = size(seg)
    const dir = Vector{Int64}([-1, -xdim, -xdim*ydim, 1, xdim, xdim*ydim])
    const dirmask  = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20]

    counts0 = 0  # number of background voxels
    counts = Int64[]  # voxel counts for each basin
    bfs = Int64[]

    next_id = 1   # initialize basin ID
    for idx in eachindex(seg)
        if seg[idx] == 0   # background voxel (no edges at all)
            seg[idx] |= high_bit(T)   # mark as assigned
            counts0 += 1;
        elseif (seg[idx] & high_bit(T))==0  # not yet assigned
            push!(bfs,idx)     # enqueue
            seg[idx] |= 0x40    # mark as visited

            bfs_index = 1  # follow trajectory starting from idx
            while ( bfs_index <= length(bfs) )
                me = bfs[bfs_index]
                for d = 1:6
                    if ( seg[me] & dirmask[d] ) !=0  # outgoing edge
                        him = me + dir[d]  # target of edge
                        if ( seg[him] & high_bit(T) ) !=0 # already assigned
                            for it in bfs  # assign entire queue to same ID
                                seg[it] = seg[him]  # including high bit
                            end
                            counts[ seg[him] & low_bits(T) ] += length(bfs);
                            bfs = Int64[]  # empty queue
                            break
                        elseif ( ( seg[him] & 0x40 ) == 0 )  # not visited
                            seg[him] |= 0x40;    # mark as visited
                            push!(bfs,him)    # enqueue
                        # else ignore since visited (try next direction)
                        end
                    end
                end
                bfs_index += 1      # go to next vertex in queue
            end

            if length(bfs) != 0     # new basin has been created
                push!(counts,length(bfs))
                for it in bfs
                    seg[it] = high_bit(T) | next_id    # assign a basin ID
                end
                next_id += 1
                bfs = Int64[]
            end
        end
    end

    println("found: ", (next_id-1)," components")

    for idx in eachindex(seg)
        seg[idx] &= low_bits(T)     # clear MSB
    end

    # manually release the memory of bfs
    bfs = []
    gc()
    (seg, counts, counts0)
end

# definitions below provided for UInt32, UInt64
# above code will presumably produce an error if some other type is used

# MSB indicates whether voxel has been assigned a basin ID
function high_bit(x::Type{UInt32})
    return 0x80000000::UInt32
end

function high_bit(x::Type{UInt64})
    return 0x8000000000000000LL::UInt64
end

function low_bits(x::Type{UInt32})
    return 0x7FFFFFFF::UInt32
end

function low_bits(x::Type{UInt64})
    return 0x7FFFFFFFFFFFFFFFLL::UInt64
end

export divideplateaus!

"""
`DIVIDEPLATEAUS!` - Divide plateaus in steepest ascent graph

     divideplateaus!(sag)

* `sag`: steepest ascent graph (directed and unweighted). `sag[x,y,z]` contains 6-bit number encoding edges outgoing from (x,y,z)

Modify steepest ascent graph so as to

1. Divide non-maximal plateaus into paths that exit as quickly as possible
2. Break ties between multiple outgoing edges

Note this is an in-place modification of `sag`
"""

function divideplateaus!(sag)
    (xdim,ydim,zdim) = size(sag)
    const dir = Vector{Int64}([-1, -xdim, -xdim*ydim, 1, xdim, xdim*ydim])
    const dirmask  = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20]
    const idirmask = [0x08, 0x10, 0x20, 0x01, 0x02, 0x04]

    # queue all vertices for which a purely outgoing edge exists
    bfs = Int64[]
    sizehint!(bfs, length(sag))
    for idx in 1:Int64(length(sag))
        for d=1:6
            if (sag[idx] & dirmask[d]) != 0   # outgoing edge exists
                if (sag[idx+dir[d]] & idirmask[d]) == 0  # no incoming edge
                    sag[idx] |= 0x40
                    append!(bfs,[idx])
                    break
                end
            end
        end
    end
    gc()
    # divide plateaus
    bfs_index = Int64(1);
    while bfs_index <= length(bfs)
        idx = bfs[bfs_index]
        to_set = 0
        for d=1:6
            if (sag[idx] & dirmask[d]) != UInt32(0)    # outgoing edge exists
                if (sag[idx+dir[d]] & idirmask[d]) != UInt32(0)  # incoming edge
                    if ( sag[idx+dir[d]] & 0x40 ) == UInt32(0)
                        push!(bfs,idx+dir[d])
                        sag[idx+dir[d]] |= 0x40
                    end
                else  # purely outgoing edge
                    to_set = dirmask[d];
                end
            end
        end
        sag[idx] = to_set    # picks unique outgoing edge, unsets 0x40 bit
        bfs_index += 1
    end
    # manually release the memory of bfs
    bfs = nothing
    gc()
    return sag
end

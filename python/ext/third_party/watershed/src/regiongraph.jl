export regiongraph

using DataStructures

"""
`REGIONGRAPH` - create region graph by finding maximum affinity between each pair of regions in segmentation

     rg = regiongraph(aff,seg,max_segid)

* `rg`: region graph as list of edges, array of (weight,id1,id2) tuples. The edges are sorted so that weights are in descending order.
* `aff`: affinity graph (undirected and weighted). 4D array of affinities, where last dimension is of size 3
* `seg`: segmentation.  Each element of the 3D array contains a *segment ID*, a nonnegative integer ranging from 0 to `max_segid`
* `max_segid`: number of segments

The vertices of the region graph are regions in the segmentation.  An
edge of the region graph corresponds to a pair of regions in the
segmentation that are connected by an edge in the affinity graph.  The
weight of an edge in the region graph is the maximum weight of the
edges in the affinity graph connecting the two regions.

The region graph includes every edge between a region and itself.
The weight of a self-edge is the maximum affinity within the region.

Background voxels (those with ID=0) are ignored.
"""

function regiongraph{Ta,Ts}(aff::Array{Ta,4},seg::Array{Ts,3},max_segid)
    (xdim,ydim,zdim)=size(seg)
    @assert size(aff) == (xdim,ydim,zdim,3)

    low = convert(Ta,0)  # choose a value lower than any affinity in the region graph
    ZERO_SEG = convert(Ts, 0)

    # edge list representation
    edges = DefaultOrderedDict{Tuple{Ts,Ts}, Ta}(low)
    # keys are vertex pairs (i,j) where i \leq j
    # values are edge weights
    # efficiency is competitive with Array of Dicts and code is simpler
    sizehint!(edges, div(length(aff), 3*5))

    for z=1:zdim
        for y=1:ydim
            for x=1:xdim
                if seg[x,y,z]!=ZERO_SEG   # ignore background voxels
                    if (x > 1) && seg[x-1,y,z]!=ZERO_SEG && seg[x,y,z]!=seg[x-1,y,z]
                        p = minmax(seg[x,y,z], seg[x-1,y,z])
                        edges[p] = max(edges[p], aff[x,y,z,1])
                    end
                    if (y > 1) && seg[x,y-1,z]!=ZERO_SEG && seg[x,y,z]!=seg[x,y-1,z]
                        p = minmax(seg[x,y,z], seg[x,y-1,z])
                        edges[p] = max(edges[p], aff[x,y,z,2])
                    end
                    if (z > 1) && seg[x,y,z-1]!=ZERO_SEG && seg[x,y,z]!=seg[x,y,z-1]
                        p = minmax(seg[x,y,z], seg[x,y,z-1])
                        edges[p] = max(edges[p], aff[x,y,z,3])
                    end
                end
            end
        end
    end

    # separate weights and vertices in two arrays
    nedges = length(edges)
    println("Region graph size: ", nedges)

    if VERSION < v"0.5-"
        weights = zeros(Ta,nedges)
        vertices = zeros(Ts,2,nedges)
        i = 1
        for (p, weight) in edges
            weights[i]=weight
            vertices[:,i]=collect(p)
            i +=1
        end
        println("Region graph size: ", nedges)

        # sort both arrays so that weights decrease
        p = sortperm(weights,rev=true)
        weights = weights[p]
        vertices = vertices[:,p]

        # repackage in array of typles
        rg = Vector{Tuple{Ta,Ts,Ts}}(nedges)
        for i = 1:nedges
            rg[i]= (weights[i], vertices[1,i], vertices[2,i])
        end
    else
        println("use region graph construction code > julia 0.4")
        # repackage in array of typles
        rg = Vector{Tuple{Ta,Ts,Ts}}(nedges)
        i = 0
        for (k,v) in edges
            i += 1
            rg[i]= (v, k[1], k[2])
        end
        sort!(rg, by=x->x[1], alg=MergeSort, rev=true)
    end
    return rg
end

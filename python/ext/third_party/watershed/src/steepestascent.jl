
export steepestascent

"""
`STEEPESTASCENT` - Construct steepest ascent graph from affinity graph

     sag = steepestascent(aff, low, high)

* `sag`: steepest ascent graph (directed and unweighted). `sag[x,y,z]` contains 6-bit number encoding edges outgoing from (x,y,z)
* `aff`: affinity graph (undirected and weighted). 4D array of affinities, where last dimension is of size 3
* `low`: edges with affinity <= `low` are removed
* `high`: affinities >= `high` are considered infinity

Directed paths in the steepest ascent graph are steepest ascent paths
in the affinity graph.  Both graphs are for 3D lattice with
6-connectivity.  The steepest ascent graph can contain vertices with
multiple outgoing edges if there are ties in the affinity graph, i.e.,
if steepest ascent paths are nonunique.

We follow the convention that:

* `aff[x,y,z,1]` is affinity of voxels at [x-1,y,z] and [x,y,z]
* `aff[x,y,z,2]` is affinity of voxels at [x,y-1,z] and [x,y,z]
* `aff[x,y,z,3]` is affinity of voxels at [x,y,z-1] and [x,y,z]
"""

function steepestascent{T}(aff::Array{T, 4},low,high)
    steepestascent(aff,convert(T,low),convert(T,high))
end

function steepestascent{T}(aff::Array{T, 4},low::T,high::T)
    @assert size(aff,4)==3
    (xdim,ydim,zdim) = size(aff)     # extract image size
    sag=zeros(UInt32,xdim,ydim,zdim)  # initialize steepest ascent graph

    for z = 1:zdim
        for y=1:ydim
            for x=1:xdim
                # weights of all six edges incident to (x,y,z)
                negx = (x>1) ? aff[x,y,z,1] : low
                negy = (y>1) ? aff[x,y,z,2] : low
                negz = (z>1) ? aff[x,y,z,3] : low
                posx = (x<xdim) ? aff[x+1,y,z,1] : low
                posy = (y<ydim) ? aff[x,y+1,z,2] : low
                posz = (z<zdim) ? aff[x,y,z+1,3] : low
                # aff=low for edges directed outside boundaries of image

                m=max(negx,negy)
		m=max(m,negz)
		m=max(m,posx)
		m=max(m,posy)
		m=max(m,posz)
#                m = maximum((negx,negy,negz,posx,posy,posz))
                #                @printf("%d %d %d %f %f %f %f %f %f\n",x,y,z,negx,negy,negz,posx,posy,posz)

                # keep edges with maximal affinity
                if ( m > low )   # no edges at all if m <= low
                    if ( negx == m || negx >= high ) sag[x,y,z] |= 0x01; end
                    if ( negy == m || negy >= high ) sag[x,y,z] |= 0x02; end
                    if ( negz == m || negz >= high ) sag[x,y,z] |= 0x04; end
                    if ( posx == m || posx >= high ) sag[x,y,z] |= 0x08; end
                    if ( posy == m || posy >= high ) sag[x,y,z] |= 0x10; end
                    if ( posz == m || posz >= high ) sag[x,y,z] |= 0x20; end
                end
            end
        end
    end
    sag
end

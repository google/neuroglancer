VERSION >=v"0.4.0-dev+6521" && __precompile__()

module Watershed
include("types.jl")
include("steepestascent.jl")
include("divideplateaus.jl")
include("findbasins.jl")
include("regiongraph.jl")
include("mergeregions.jl")
include("mst.jl")

# the main functions
include("segment.jl")

end

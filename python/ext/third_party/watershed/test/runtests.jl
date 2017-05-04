using Watershed

aff = rand(Float32, 1024,1024,128,3);

# watershed(aff)

#println("watershed ...")
#@time watershed(aff)

# @profile watershed(aff)
# Profile.print()
low = 0.1
high = 0.8
thresholds = []
dust_size = 1

# first time run
println("first time run...\n")
watershed(aff; is_threshold_relative=true)

println("steepestascent...\n\n")
@time seg = steepestascent(aff, low, high)
println("divideplateaus...")
@time divideplateaus!(seg)
println("findbasins...")
@time (seg, counts, counts0) = findbasins!(seg)
println("regiongraph...")
@time rg = regiongraph(aff, seg, length(counts))
println("mergeregions...")
@time new_rg = mergeregions!(seg, rg, counts, thresholds, dust_size)
println("mst...")
@time rg = mst(new_rg, length(counts))

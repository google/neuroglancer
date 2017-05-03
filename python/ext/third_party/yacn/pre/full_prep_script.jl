push!(LOAD_PATH, dirname(@__FILE__))
import Save
using VirtualArrays
using HDF5

include("utils.jl")
include("reweight2.jl")
include("compute_regiongraph.jl")
include("compute_fullgraph.jl")
include("filter_samples.jl")
include("compute_proofreadgraph.jl")

function do_prep(in_dir, out_dir; patch_size = (318,318,33), ground_truth=false, compute_full_edges=false, compute_samples=true)

	load = f->Save.load(joinpath(in_dir, f))
	save = (f,x)->Save.save(joinpath(out_dir,f),x)

	raw = load("raw.h5")
	full_size = size(raw)
	println(full_size)

	mean_labels = load("mean_agg_tr.h5")
	#remap = load("remap.h5")
	#mean_labels = collect(remap_array(raw, remap))
	#save("mean_labels.h5", mean_labels)

	if compute_samples
		#the sample around a point x is [x-floor(patch_size/2): x-floor(patch_size/2)+patch_size]
		central_ranges = [Int(floor(p/2) + 1) : Int(s - p + floor(p/2) + 1) for (p,s) in zip(patch_size, full_size)]
		println(map(length,central_ranges))
		println(patch_size)
		mask = zeros(Int8, full_size)
		mask[central_ranges...] = 1
		samples = gen_samples(mean_labels, patch_size, N=round(Int,0.0003*length(raw)), mask=mask, M=30)
		save("samples.h5", flatten(samples))
	end

	vertices = unique(raw)
	save("vertices.h5", vertices)

	affinities = load("aff.h5")
	@time mean_edges = compute_regiongraph(raw, mean_labels, affinities, threshold=0.3)
	save("mean_edges.h5", mean_edges)

	@time mean_contact_edges = compute_regiongraph(raw, mean_labels)
	save("mean_contact_edges.h5", mean_edges)

	if compute_full_edges
		full_edges = compute_fullgraph(Batched(), raw, resolution=Int[4,4,40], radius=130, downsample=Int[4,4,1])
		save("full_edges.h5", full_edges)
	end

	contact_edges = compute_contactgraph(raw)
	save("contact_edges.h5", contact_edges)
	
	if ground_truth
		valid = to_indicator(parse_valid_file(joinpath(in_dir,"valid.txt")))
		save("valid.h5",valid)

		vertices = load("vertices.h5")
		full_edges = load("full_edges.h5")
		proofread = load("proofread.h5")
		proofread_edges = compute_proofreadgraph(raw,proofread,vertices,full_edges)
		Save.save("proofread_edges.h5", proofread_edges)

		samples = load("samples.h5")
		samples = Tuple{Int,Int,Int}[tuple(samples[:,i]...) for i in 1:size(samples,2)]
		valid_samples = filter(x->(valid[raw[x[3]+1,x[2]+1,x[1]+1]+1]==1), samples)
		save("valid_samples.h5",flatten(valid_samples))

		padded_valid_samples = filter(samples_filter(full_size, Int[patch_size...] + 2*[20,20,0]),valid_samples)

		println(map(length,[minimum([x[i] for x in samples]) : maximum([x[i] for x in samples])for i in 1:3]))
		println(map(length,[minimum([x[i] for x in padded_valid_samples]) : maximum([x[i] for x in padded_valid_samples])for i in 1:3]))

		println(length(padded_valid_samples))
		Save.save("padded_valid_samples.h5", flatten(padded_valid_samples[1:250000]))
	end
end

#basename = expanduser(ARGS[1])
@time do_prep(expanduser(ARGS[1]),expanduser(ARGS[2]), ground_truth=false, compute_full_edges=false)
#=
for i in 1:3
	for j in 1:3
		do_prep(expanduser("~/mydatasets/$(i)_$(j)_1"), ground_truth=true, compute_full_edges=true, compute_samples=false)
	end
end
=#

using PyCall
using Save
using DataStructures

@pyimport scipy.spatial as sp

function flatten{N,T}(A::Vector{NTuple{N,T}})
	A_flat=fill(zero(T),(N,length(A)))
	for i in 1:length(A)
		for j in 1:N
			A_flat[j,i]=A[i][j]
		end
	end
	return A_flat
end
function unordered(x,y)
	return (min(x,y),max(x,y))
end
abstract ComputeMode
immutable Direct <: ComputeMode end
immutable Batched <: ComputeMode end

function compute_fullgraph{T}(mode::Batched,raw::Array{T,3}; resolution=Int[4,4,40], radius=130,downsample=Int[4,4,1])
	voxel_radius = round(Int, Int[radius,radius,radius] ./ resolution, RoundUp)

	patch_size = max(Int[500,500,50], 2*voxel_radius)
	step_size = patch_size - voxel_radius
	println(voxel_radius)
	println(patch_size)
	println(step_size)
	edges=Set{Tuple{T,T}}()

	rk = 0:step_size[3]:size(raw,3)
	rj = 0:step_size[2]:size(raw,2)
	ri = 0:step_size[1]:size(raw,1)
	N=prod(map(length, [ri,rj,rk]))
	n=0
	for k in rk, j in rj, i in ri
		n+=1
		println("$(n)/$(N)")
		union!(edges,compute_fullgraph_direct(
								raw[i+1:min(i+patch_size[1],size(raw,1)),
								j+1:min(j+patch_size[2],size(raw,2)),
								k+1:min(k+patch_size[3],size(raw,3))],
								resolution=resolution, 
								downsample=downsample,
								radius=radius, pre_verified = edges))
	end
	ret = flatten(collect(edges))
	println("Collected $(length(ret)) edges")
	return ret
end
function compute_fullgraph{T}(mode::Direct, raw::Array{T,3}; resolution=Int[4,4,40], radius=130, downsample=Int[4,4,1])
	return flatten(collect(compute_fullgraph_direct(raw, resolution=resolution, radius=radius, downsample=downsample)))
end

function compile_candidates{T}(raw::Array{T,3}, step_size, patch_size)
	s=Set{Tuple{T,T}}()

	rk = 0:step_size[3]:size(raw,3)
	rj = 0:step_size[2]:size(raw,2)
	ri = 0:step_size[1]:size(raw,1)
	for k in rk, j in rj, i in ri
		l=unique(raw[i+1:min(i+patch_size[1],size(raw,1)), j+1:min(j+patch_size[2],size(raw,2)), k+1:min(k+patch_size[3], size(raw,3))])
		for I in 1:length(l)
			for J in I+1:length(l)
				@inbounds if l[I]!=0 && l[J] != 0
					push!(s,unordered(l[I],l[J]))
				end
			end
		end
	end
	return s
end

#Computes all pairs of supervoxels whose minimum distance is less than a fixed distance
#radius is given in nm
#pre_verified is a set of edges that we already know are in the graph
function compute_fullgraph_direct{T}(raw::Array{T,3}; downsample = Int[4,4,1], resolution=Int[4,4,40], radius=130, pre_verified = Set{Tuple{T,T}}())
	point_lists=DefaultDict{T,Set{Tuple{Int32,Int32,Int32}}}(()->Set{Tuple{Int32,Int32,Int32}}())

	#accumulating points
	for k in 1:size(raw,3), j in 1:size(raw,2), i in 1:size(raw,1)
		if raw[i,j,k] != 0 &&
			(
				(i > 1 && raw[i,j,k] != raw[i-1,j,k]) ||
				(j > 1 && raw[i,j,k] != raw[i,j-1,k]) ||
				(k > 1 && raw[i,j,k] != raw[i,j,k-1]) ||

				(i < size(raw,1) && raw[i,j,k] != raw[i+1,j,k]) ||
				(j < size(raw,2) && raw[i,j,k] != raw[i,j+1,k]) ||
				(k < size(raw,3) && raw[i,j,k] != raw[i,j,k+1])
			)

			push!(point_lists[raw[i,j,k]],((i-mod(i,downsample[1]))*resolution[1],(j-mod(j,downsample[2]))*resolution[2],(k-mod(k,downsample[3]))*resolution[3]))
		end
	end
	
	#generate trees
	trees = Dict(i => sp.cKDTree(transpose(flatten(collect(points)))) for (i,points) in point_lists)

	upper_voxel_radius = round(Int, Int[radius,radius,radius] ./ resolution, RoundUp)
	lower_voxel_radius = round(Int, Int[radius,radius,radius] ./ resolution, RoundDown)
	patch_size = round(Int,1.5*upper_voxel_radius,RoundUp)
	step_size = patch_size - upper_voxel_radius

	candidates=compile_candidates(raw, step_size, patch_size)
	verified = compile_candidates(raw, round(Int,0.5*lower_voxel_radius), lower_voxel_radius)

	#compute distances
	edges = Tuple{T,T}[]
	for (i,j) in candidates
		if (i,j) in verified || (i,j) in pre_verified || trees[i][:count_neighbors](trees[j],r=radius,p=Inf) > 0
			push!(edges,unordered(i,j))
		end
	end
	return edges
end

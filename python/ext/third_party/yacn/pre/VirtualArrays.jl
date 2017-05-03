module VirtualArrays
export VirtualArray

export remap_array

immutable VirtualArray{S,F}
	raw::Array{S,3}
	f::F
end

@inline Base.getindex(A::VirtualArray, i, j, k) = f(A.raw[i,j,k])
Base.size(A::VirtualArray) = size(A.raw)

function remap_array{T,S}(raw::Array{T,3}, remap::Array{S,1})
	return VirtualArray(raw,(x-> x==zero(T) ? zero(S) : remap[x]))
end

function Base.collect(A::VirtualArray)
	return map(A.f, A.raw)
end

end

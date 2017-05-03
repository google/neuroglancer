function mapping{T,S}(vertices, raw::Array{T,3},proofread::Array{S,3})
	d=Dict{T,S}()
	for i in eachindex(raw,proofread)
		if haskey(d,raw[i])
			@assert d[raw[i]] == proofread[i]
		else
			d[raw[i]]=proofread[i]
		end
	end
	d
end

function compute_proofreadgraph{T}(raw, proofread, vertices, full_edges::Array{T,2})
	d=mapping(vertices, raw, proofread)
	L = Tuple{T,T}[tuple(full_edges[1,i],full_edges[2,i]) for i in 1:size(full_edges,2)]
	L_filtered = filter(e->d[e[1]]==d[e[2]], L)
	return flatten(L_filtered)
end

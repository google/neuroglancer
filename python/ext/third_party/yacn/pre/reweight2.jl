FFTW.set_num_threads(Sys.CPU_CORES)
using DataStructures
function squeeze_labels{T<:Integer,N}(labels::Array{T,N})
	counter=zero(T)
	d=DefaultDict{T,T}(()->begin counter += 1; counter end)
	d[0]=0
	return map(i->d[i], labels)::Array{T,N}
end

function gen_weights(labels; M=30, kernel_size=[100,100,20], max_factor=20)
	labels = squeeze_labels(labels)
	labels+=1
	N=maximum(labels)
	tmp = randn(N,M)
	relabels = tmp ./ sqrt(sum(tmp.^2,2))

	#We always turn the boundary off
	relabels[1,:]=0

	kernel = fill(0f0, size(labels))
	kernel[[1:x for x in kernel_size]...]=1
	kernel = circshift(kernel,[round(Int,-x/2) for x in kernel_size]) / sum(kernel)

	plan = plan_fft(kernel, [1,2,3])
	iplan = inv(plan)
	fft_kernel=plan*(kernel)

	weights=fill(0f0, size(labels))
	indicator = similar(fft_kernel)
	intermediate = similar(fft_kernel)
	smoothed = similar(fft_kernel)
	println("here")
	for j in 1:M
		println(j)
		println("relabelling...")
		@time for i in eachindex(indicator, labels)
			indicator[i] = relabels[labels[i],j]
		end
		println("convolution...")
		begin
			@time A_mul_B!(intermediate, plan, indicator) 
			@time for i in eachindex(intermediate,fft_kernel)
				intermediate[i]=intermediate[i]*fft_kernel[i]
			end
			@time A_mul_B!(smoothed, iplan, intermediate)
		end
		println("update...")
		@time for i in eachindex(weights, smoothed, indicator)
			weights[i] += real(smoothed[i]*indicator[i])
		end
	end
	for i in eachindex(weights,labels)
		if labels[i]==1
			weights[i]=0
		else
			weights[i] = 1f0 / min(1f0,max(1f0/max_factor, weights[i]))
		end
	end
	return weights
end

#We always output zyx, zero based indices
function gen_samples(labels, patch_size; kernel_size=map(x->round(Int,x/2),patch_size), N=100000, M=30, mask=1)
	weights = gen_weights(labels, kernel_size = kernel_size, M=M) .* mask
	#Save.save("weights.h5",weights)
	weights *= (N/sum(weights))

	A=Vector{Int}[]

	for k in 1:size(weights,3), j in 1:size(weights,2), i in 1:size(weights,1)
		if rand() <= weights[i,j,k]
			push!(A,Int[i,j,k])
		end
	end

	println("$(length(A)) examples collected")
	return shuffle(Tuple{Int,Int,Int}[tuple((reverse(x)-1)...) for x in A])
end

function stars(shape,samples)
	samples = samples[end:-1:1,:]+1
	tmp=zeros(UInt32,shape)
	for i in 1:size(samples,2)
		tmp[samples[1,i],samples[2,i],samples[3,i]]=1
	end
	return tmp
end


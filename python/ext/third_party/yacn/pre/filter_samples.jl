function samples_filter(full_size, padding)
	function f(sample)
		#sample is a zero based, zyx index
		return all([0 <= x-round(Int, p/2,RoundDown) <= c - p for (x,p,c) in zip(reverse(sample), padding, full_size)])
	end
	return f
end

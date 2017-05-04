push!(LOAD_PATH, dirname(@__FILE__))

using Watershed
using HDF5

input_path = ARGS[1]
print("input path: ")
print(input_path)

output_path = ARGS[2]
print("\noutput path: ")
print(output_path)

high_threshold = parse(Float32,ARGS[3])
print("\nhigh_threshold: ")
print(high_threshold)

low_threshold = parse(Float32,ARGS[4])
print("\nlow: ")
print(low_threshold)

merge_threshold = parse(Float32,ARGS[5])
print("\nmerge_threshold: ")
print(merge_threshold)

merge_size = parse(Int64,ARGS[6])
print("\nmerge_size: ")
print(merge_size)

dust_size = parse(Int64,ARGS[7])
print("\ndust_size: ")
print(dust_size)
print("\n")


aff = h5read(input_path,"main");
seg = atomicseg(aff, low=low_threshold, high=high_threshold, thresholds=[(merge_size, merge_threshold)], dust_size=dust_size, is_threshold_relative=false)
h5open(output_path, "w") do file
    write(file, "/main", seg)
end

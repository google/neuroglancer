using Watershed
using EMIRT
using HDF5
using Base.Test

aff = h5read(joinpath(Pkg.dir(), "Watershed/assets/piriform.aff.h5"), "main")

#seg = atomicseg(aff)
seg, rg = watershed(aff; is_threshold_relative = true)

#h5write(joinpath(Pkg.dir(), "Watershed/assets/piriform.seg.h5", "seg", seg)
#h5write("seg.h5", "seg", seg)

# compare with segmentation

seg0 = readseg(joinpath(Pkg.dir(), "Watershed/assets/piriform.seg.h5"))

err = segerror(seg0, seg)

@show err
@test_approx_eq err[:re]  0

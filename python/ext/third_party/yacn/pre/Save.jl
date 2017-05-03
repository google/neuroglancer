module Save
using HDF5

export save, load, load_mmap
immutable Path{T} 
	prefix::AbstractString
	ext::AbstractString
end
function Path(s::AbstractString)
	prefix,ext = splitext(s)
	Path{Symbol(ext[2:end])}(prefix,ext)
end

function save(path::Path{:jls},x)
	f=open("$(path.prefix).jls","w")
	serialize(f,x)
	close(f)
end
function save{T}(path::Path{:raw},x::Array{T})
	f=open("$(path.prefix).raw","w")
	write(f,x)
	close(f)
	f2=open("$(path.prefix).meta","w")
	write(f2,"$(T)$(size(x))")
	close(f2)
end
function load_mmap(path::Path{:raw})
	f2=open("$(path.prefix).meta","r")
	spec=parse(readline(f2))
	close(f2)
	T=eval(spec.args[1])
	dims=tuple(spec.args[2:end]...)

	f=open("$(path.prefix).raw","r")
	ret=Mmap.mmap(f,Array{T,length(dims)},dims)
	close(f)
	return ret
end
function save(path::Path{:h5},x)
	h5open("$(path.prefix).h5", "w") do file
		write(file, "/main", x)
	end
end
function load(path::Path{:h5})
	h5read("$(path.prefix).h5", "/main")
end

function load(path::Path{:jls})
	return deserialize(open("$(path.prefix).jls","r"))
end
function load(path::Path{:raw})
	f2=open("$(path.prefix).meta","r")
	spec=parse(readline(f2))
	close(f2)
	T=eval(spec.args[1])
	dims=tuple(spec.args[2:end]...)

	f=open("$(path.prefix).raw","r")
	A=Array(T,dims)
	read!(f,A)
	close(f)
	A
end

function save(path::AbstractString, x)
	path = expanduser(path)
	print("Saving to $(path)...")
	tmp=save(Path(path), x)
	println("done.")
	return tmp
end
function load(path::AbstractString)
	path = expanduser(path)
	print("Loading from $(path)...")
	tmp=load(Path(path))
	println("done.")
	return tmp
end
function load_mmap(path::AbstractString)
	path = expanduser(path)
	print("Loading from $(path)...")
	tmp=load_mmap(Path(path))
	println("done.")
	return tmp
end
end

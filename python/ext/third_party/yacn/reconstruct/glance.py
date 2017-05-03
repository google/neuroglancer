#!/usr/bin/python

from __future__ import print_function
import graph_server
import os
import sys
import webbrowser
import subprocess
import operator
import h5py

import neuroglancer
import numpy as np
import os.path

from regiongraphs import *
from reconstruct import *
from misc_utils import *

import scipy.ndimage.measurements as measurements
import random


patch_size=[33,318,318]
resolution=[40,4,4]
full_size=[256,2048,2048]

neuroglancer.server.debug=False
neuroglancer.server.global_server_args['bind_address']='seung-titan02.pni.princeton.edu'
neuroglancer.server.global_server_args['bind_port']=80
neuroglancer.server.global_bind_port2=9100
neuroglancer.volume.ENABLE_MESHES=True

def random_shader():
	x=random.random()
	y=random.random()
	z=random.random()
	s=x+y+z
	x=1.0-x/s
	y=1.0-y/s
	z=1.0-z/s
	return """void main() {{
			  emitRGBA(
					vec4({}*toNormalized(getDataValue()),
					{}*toNormalized(getDataValue()),
					{}*toNormalized(getDataValue()),
					toNormalized(getDataValue())
						 )
					  );
			}}
			""".format(x,y,z)

def get_focus():
	return map(int, rev(viewer.state['navigation']['pose']['position']['voxelCoordinates']))

def get_selection():
	s=set(map(int,viewer.state['layers']['raw_labels']['segments']))
	return s

def set_selection(segments,append=False,expand=True):
	if expand:
		segments = bfs(V.G, segments)
	segments = map(int, segments)
	if append:
		segments = segments + list(get_selection())
	segments = sorted(list(segments))
		
	viewer.state['layers']['raw_labels']['segments'] = segments
	print(viewer.state['layers']['raw_labels']['segments'])
	viewer.broadcast()
	draw_edges(V.G.subgraph(segments))

def set_focus(pos):
	global cutout
	global V
	cutout = cutout=SubVolume(V,get_region(V,pos))
	cutout.pos=pos
	draw_bbox(pos)
	viewer.state['navigation']['pose']['position']['voxelCoordinates'] = rev(pos)
	viewer.broadcast()

def rev(x):
	if type(x) == tuple:
		return tuple(reversed(x))
	else:
		return list(reversed(x))

counter=0

def trace():
	s=get_selection()
	mask = indicator(cutout.raw_labels,s)
	central = indicator(cutout.raw_labels,[V.raw_labels[tuple(cutout.pos)]])
	cutout.traced = reconstruct_utils.trace_daemon(cutout.image, mask, central)

	global counter
	counter += 1
	viewer.add(data=cutout.traced, volume_type='image', name='trace'+str(counter), voxel_size=rev(resolution), offset=rev([(cutout.pos[i]-patch_size[i]/2)*resolution[i] for i in xrange(3)]), shader=random_shader())
	l=viewer.layers[-1]
	viewer.register_volume(l.volume)
	viewer.state['layers']['trace'+str(counter)]=l.get_layer_spec(viewer.get_server_url())
	viewer.broadcast()
	print("done")


def draw_edges(G):
	tmp = []
	for u,v in G.edges():
		tmp.append(rev(V.centroids[u,:]))
		tmp.append(rev(V.centroids[v,:]))
	viewer.state['layers']['edges']['points'] = tmp
	viewer.broadcast()

def draw_bbox(position):
	position = rev(position)
	rps = rev(patch_size)
	tmp=[]
	for i in [-1,1]:
		for j in [-1,1]:
			for k in [-1,1]:
				if i == - 1:
					tmp.append(map(operator.add,position, [i*rps[0]/2, j*rps[1]/2, k*rps[2]/2]))
					tmp.append(map(operator.add,position, [-i*rps[0]/2, j*rps[1]/2, k*rps[2]/2]))
				if j == - 1:
					tmp.append(map(operator.add,position, [i*rps[0]/2, j*rps[1]/2, k*rps[2]/2]))
					tmp.append(map(operator.add,position, [i*rps[0]/2, -j*rps[1]/2, k*rps[2]/2]))
				if k == - 1:
					tmp.append(map(operator.add,position, [i*rps[0]/2, j*rps[1]/2, k*rps[2]/2]))
					tmp.append(map(operator.add,position, [i*rps[0]/2, j*rps[1]/2, -k*rps[2]/2]))

	viewer.state['layers']['bbox']['points'] = tmp
	viewer.broadcast()

def select_neighbours(threshold=0.5):
	if GLOBAL_EXPAND:
		g = V.G
	else:
		g = cutout.G
	current_segments = bfs(g,[V.raw_labels[tuple(cutout.pos)]]+cutout.local_errors(threshold=ERROR_THRESHOLD))
	set_selection(current_segments, append=False, expand=False)

def perturb_position(radius=PERTURB_RADIUS):
	pos=get_focus()
	new_pos = perturb(get_focus(),V,radius=radius)
	set_focus(new_pos)

def load(ind=None,append=False):
	if ind is None:
		pos = get_focus()
		z,y,x = pos
	elif type(ind)==int:
		global current_index
		current_index=ind
		z,y,x = V.samples[ind,:]
		pos = [z,y,x]
	else:
		pos=ind
		z,y,x=pos

	set_selection([int(V.raw_labels[z,y,x])], append=append)
	set_focus(pos)


def auto_trace():
	perturb_position()
	raw_input("press enter to continue")
	select_neighbours(threshold=ERROR_THRESHOLD)
	raw_input("press enter to continue")
	trace()
	raw_input("press enter to continue")
	commit(cutout)
	raw_input("press enter to continue")
	load(cutout.pos)

current_index = 0
def next_index(jump=1):
	global current_index
	current_index = current_index + jump
	return current_index

neuroglancer.set_static_content_source(url='http://seung-titan02.pni.princeton.edu:8080')

#basename = sys.argv[1]
basename=os.path.expanduser("~/mydatasets/3_3_1/")
print("loading files...")
vertices = h5read(os.path.join(basename, "vertices.h5"), force=True)
edges = h5read(os.path.join(basename, "epoch1_edges.h5"), force=True)

V = Volume(basename,
		{"image": "image.h5",
		 "errors": "epoch1_errors.h5",
		 "raw_labels": "raw.h5",
		 "affinities": "aff.h5",
		 "valid_list": "valid.h5",
		 "centroids": "raw_centroids.h5",
		 #"machine_labels": "epoch1_machine_labels.h5",
		 #"human_labels": "proofread.h5",
		 "changed": np.zeros(full_size, dtype=np.int32),
		 "valid": set([]),
		 "glial": set([]),
		 "G": regiongraphs.make_graph(vertices,edges),
		 "samples": h5read(os.path.join(basename, "samples.h5"), force=True),
		 })
V.errors = V.errors[:]
V.full_size=V.errors.shape

"""
import read_otpt
n=0
l=read_otpt.dend_splits
def next_error():
	global n
	set_selection([l[n% len(l)]])
	n=n+1
"""

print("done")

#graph_server_url=graph_server.start_server(V.G)
#graph_server_url="http://localhost:8088"

print("sorting samples...")
sort_samples(V)
print("...done")

viewer = neuroglancer.Viewer()
def on_state_changed(state):
	if neuroglancer.server.debug:
		print(state)

def show_points():
	viewer.state['layers']['samples']['points'] = [rev(V.samples[i,:]) for i in xrange(8000)]
	viewer.broadcast()

viewer.on_state_changed = on_state_changed
#viewer.add(data=np.array([[[0]]],dtype=np.uint8), volume_type='image', name='dummy', voxel_size=rev(resolution))
viewer.add(data=V.image, volume_type='image', name='image', voxel_size=rev(resolution))
viewer.add(data=V.errors, volume_type='image', name='errors', voxel_size=rev(resolution))
#viewer.add(data=V.machine_labels, volume_type='segmentation', name='machine_labels', voxel_size=rev(resolution))
viewer.add(data=V.raw_labels, volume_type='segmentation', name='raw_labels', voxel_size=rev(resolution))
#viewer.add(data=V.human_labels, volume_type='segmentation', name='human_labels', voxel_size=rev(resolution))
viewer.add(data=[], volume_type='synapse', name="bbox")
viewer.add(data=[], volume_type='point', name="samples")
viewer.add(data=[], volume_type='synapse', name="edges")
#viewer.add(data=np.array([[[0]]],dtype=np.uint8), volume_type='image', name='dummy', voxel_size=rev(resolution))

print('open your browser at:')
print(viewer.__str__())
#webbrowser.open(viewer.__str__())

from __future__ import print_function
import regiongraphs
from regiongraphs import *
import reconstruct_utils
import scipy.ndimage.measurements as measurements
import scipy.ndimage as ndimage
import numpy as np
import pandas as pd
import misc_utils
import sys
import traceback
from datetime import datetime
from misc_utils import *

import os
import os.path

params = {
'PERTURB_RADIUS': (1,15,15),
'patch_size': [33,318,318],
'LOW_THRESHOLD': 0.1,
'HIGH_THRESHOLD': 0.9,
'DUST_THRESHOLD': [8,78,78],
'CENTRAL_CROP': 0.33333,
'VISITED_CROP': 0.33333,
'ERRORS_CROP': 0.15,
'N_EPOCHS': 4,
'N_STEPS': 30000,
'GLOBAL_EXPAND': False,
'ERROR_THRESHOLD': 0.5,
'COST_BENEFIT_RATIO': 2,
'PARENT': "",
'RANDOMIZE_BATCH': 1000,
}
print(params)
for x in params:
	globals()[x]=params[x]

class ReconstructionException(Exception):
	pass

class Volume():
	def __init__(self, directory, d):
		self.directory=directory
		for (k,v) in d.items():
			if type(v)==type(""):
				setattr(self, k, h5read(os.path.join(directory, v)))
			else:
				setattr(self, k, v)

class SubVolume():
	def __init__(self, parent, region):
		self.parent = parent
		self.region = region
	
	def __getattr__(self, name):
		if name == "unique_list":
			self.unique_list = unique_nonzero(self.raw_labels)
		elif name == "central_unique_list":
			subregion = crop_region(patch_size, CENTRAL_CROP)
			self.central_unique_list = unique_nonzero(self.raw_labels[subregion])
		elif name == "G":
			if GLOBAL_EXPAND:
				self.G = self.parent.G
			else:
				self.G = self.parent.G.subgraph(self.unique_list)
		elif name == "local_human_labels":
			proofread_G = self.parent.proofread_G.subgraph(self.unique_list)
			tic()
			self.local_human_labels = flatten(proofread_G, self.raw_labels)
			toc("local labels")

		elif name == 'current_object':
			central_segments = bfs(self.G,[self.raw_labels[tuple([(x.stop-x.start)/2 for x in self.region])]])
			self.current_object = indicator(self.raw_labels,central_segments)
		else:
			setattr(self, name, getattr(self.parent,name)[self.region])
		return getattr(self,name)

	def local_errors(self, threshold):
		subregion = crop_region(patch_size, ERRORS_CROP)
		unique_list = unique_nonzero(self.raw_labels[subregion])

		max_error_list = measurements.maximum(self.errors,self.raw_labels, unique_list)
		additional_segments = [unique_list[i] for i in xrange(len(unique_list)) if max_error_list[i]>threshold or max_error_list[i]==0.0]
		additional_segments = filter(lambda x: x != 0 and x not in self.parent.valid, additional_segments)

		return additional_segments


def get_region(V,pos):
	full_size = V.full_size
	if not all([patch_size[i]/2 < pos[i] < (full_size[i] - patch_size[i]/2) for i in range(3)]):
		raise ReconstructionException("out of bounds")
	return tuple([slice(pos[i]-patch_size[i]/2,pos[i]+patch_size[i]-patch_size[i]/2) for i in range(3)])

def crop(A, trim):
	return A[crop_region(A.shape, trim)]

def crop_region(patch_size, trim):
	return tuple([slice(
		int(x*trim),
		int(x - x*trim))
		for x in patch_size])

def analyze(cutout,example_id):
	V=cutout.parent
	unique_list = cutout.central_unique_list
	args = [cutout.raw_labels, unique_list]
	tic()
	guess = measurements.mean(cutout.traced, *args)
	truth = measurements.mean(cutout.local_human_labels[np.unravel_index(np.argmax(cutout.traced),cutout.raw_labels.shape)]==cutout.local_human_labels, *args)
	volumes = measurements.sum(np.ones_like(cutout.raw_labels), *args)
	histogram_list = list(ndimage.histogram(cutout.traced, 0, 1, 10, *args))
	histogram = np.histogram(crop(cutout.traced, CENTRAL_CROP), bins=10)
	toc("compute statistics")


	tic()
	positive = [unique_list[i] for i in xrange(len(unique_list)) if guess[i] > 0.5]
	negative = [unique_list[i] for i in xrange(len(unique_list)) if guess[i] <= 0.5]
	new_graph = V.G.subgraph(cutout.unique_list).copy()

	regiongraphs.add_clique(new_graph, positive)
	regiongraphs.delete_bipartite(new_graph,positive,negative)

	new_obj = indicator(cutout.raw_labels, bfs(new_graph, positive))
	new_errors_cutout = crop(reconstruct_utils.discrim_online_daemon(cutout.image, new_obj), ERRORS_CROP)
	old_errors_cutout = crop(cutout.errors * new_obj, ERRORS_CROP)
	#d_error = crop(new_errors_cutout,ERRORS_CROP) - crop(old_errors_cutout,ERRORS_CROP)
	#print(np.histogram(d_error, bins=20, range=(-1.0,1.0)))

	satisfaction = np.sum(crop(np.abs(cutout.current_object - cutout.traced), CENTRAL_CROP))
	toc("computing change in error")

	guess_margin = np.min(np.append(guess[guess > 0.5],1)) - np.max(np.append(guess[guess <= 0.5],0))
	true_margin = np.min(np.append(guess[truth > 0.5],1)) - np.max(np.append(guess[truth <= 0.5],0))


	df1 = pd.DataFrame.from_dict(
			{
				"guess": guess,
				"truth": truth,
				"volume": volumes,
				"seg_id": unique_list,
				"example_id": [example_id for i in unique_list],
				"histogram": histogram_list
			}
			)
	df2 = pd.DataFrame.from_dict(
			{
				"guess_margin": [guess_margin],
				"true_margin": [true_margin],
				"err_max": [np.max(new_errors_cutout)],
				"err_min": [np.min(new_errors_cutout)],
				"err_mean": [np.mean(new_errors_cutout)],
				"satisfaction": [satisfaction],
				"histogram": [histogram],
				"example_id": [example_id]
			}
			)
	return df1, df2

def commit(cutout, low_threshold=LOW_THRESHOLD, high_threshold=HIGH_THRESHOLD, cost_benefit_ratio = COST_BENEFIT_RATIO, close = lambda x,y: True, force=False):
	V=cutout.parent
	unique_list = cutout.central_unique_list


	traced_list = measurements.mean(cutout.traced, cutout.raw_labels, unique_list)
	current_list = measurements.mean(cutout.current_object, cutout.raw_labels, unique_list)
	volumes = measurements.sum(np.ones_like(cutout.current_object), cutout.raw_labels, unique_list)

	positive_indices = [i for i in xrange(len(unique_list)) if traced_list[i]>high_threshold]
	uncertain_indices = [i for i in xrange(len(unique_list)) if low_threshold <= traced_list[i] <= high_threshold]
	negative_indices = [i for i in xrange(len(unique_list)) if traced_list[i]<low_threshold]

	cost = sum([volumes[i]*max(traced_list[i],1-traced_list[i]) for i in uncertain_indices]) + \
		sum([volumes[i]*traced_list[i] for i in negative_indices]) + \
		sum([volumes[i]*(1-traced_list[i]) for i in positive_indices])
	benefit = sum([abs(volumes[i]*(traced_list[i]-current_list[i])) for i in positive_indices + negative_indices])
	"""
	cost = sum([volumes[i] * traced_list[i]*(1-traced_list[i]) for i in xrange(len(unique_list))])
	benefit = sum([abs(volumes[i]*(round(traced_list[i])-current_list[i])) for i in xrange(len(unique_list))])
	"""
	print("cost " + str(cost))
	print("benefit " + str(benefit))
	
	if not (len(uncertain_indices)==0 or (cost_benefit_ratio is not None and benefit > cost_benefit_ratio * cost) or force):
		raise ReconstructionException("not confident")

	split_point = (high_threshold + low_threshold)/2
	rounded_positive = [unique_list[i] for i in xrange(len(unique_list)) if traced_list[i] > split_point]
	rounded_negative = [unique_list[i] for i in xrange(len(unique_list)) if traced_list[i] <= split_point]

	if not V.valid.isdisjoint(rounded_positive):
		raise ReconstructionException("blocking merge to valid segment")

	full_segment = bfs(V.G, rounded_positive)
	if not V.glial.isdisjoint(full_segment):
		raise ReconstructionException("blocking merge to glial cell")
	if len(V.dendrite & full_segment) > 2:
		raise ReconstructionException("blocking merge of two dendritic trunks")

	original_components = list(nx.connected_components(V.G.subgraph(cutout.unique_list)))
	regiongraphs.add_clique(V.G,rounded_positive, guard=close)
	regiongraphs.delete_bipartite(V.G,rounded_positive,rounded_negative)
	new_components = list(nx.connected_components(V.G.subgraph(cutout.unique_list)))
	changed_list = set(cutout.unique_list) - set.union(*([set([])]+[s for s in original_components if s in new_components]))
	changed_cutout = indicator(cutout.raw_labels,  changed_list)
	V.changed[cutout.region] = np.maximum(V.changed[cutout.region], changed_cutout)

	if not GLOBAL_EXPAND:
		cutout.G = V.G.subgraph(cutout.unique_list)

	return len(changed_list) > 0

def perturb(sample, V, radius=PERTURB_RADIUS):
	region = tuple([slice(x-y,x+y+1,None) for x,y in zip(sample,radius)])
	mask = (V.raw_labels[region]==V.raw_labels[tuple(sample)]).astype(np.int32)

	patch = np.minimum(V.affinities[(0,)+region], mask)
	tmp=np.unravel_index(patch.argmax(),patch.shape)
	return [t+x-y for t,x,y in zip(tmp,sample,radius)]

def recompute_errors(V):
	print("recomputing errors")
	tic()
	pass_errors = np.minimum(V.errors, 1-V.changed)
	pass_visited = 2*(1 - V.changed)
	V.machine_labels = flatten(V.G,V.raw_labels)
 	samples = np.array(filter(lambda i: V.changed[i[0],i[1],i[2]]>0, V.samples))

	packed = map(reconstruct_utils.pack,[V.image[:], V.machine_labels, samples, pass_errors, pass_visited])
	V.errors = reconstruct_utils.unpack(reconstruct_utils.discrim_daemon(*packed))
	toc("done recomputing errors")

def sort_samples(V):
	nsamples = V.samples.shape[0]
	weights = V.errors[[V.samples[:,0],V.samples[:,1],V.samples[:,2]]]
	print(np.histogram(weights, bins=20))
	perm = np.argsort(weights, kind='mergesort')[::-1]
	V.samples=V.samples[perm,:]
	V.weights=weights[perm]

def reconstruct_volume(V, dry_run = False, analyze_run = False, logdir=None):
	if logdir is not None:
		if not os.path.exists(logdir):
			os.makedirs(logdir)
		with open(os.path.join(logdir,"params"),'w') as f:
			for x in params:
				print(x + ": " + str(params[x]), file=f)

	if analyze_run:
		df_segments=pd.DataFrame([],columns=[])
		df_examples=pd.DataFrame([],columns=[])

	V.full_size = V.image.shape
	V.errors = V.errors[:]
	V.samples = V.samples[:]
	V.edges = V.edges[:]
	V.vertices = V.vertices[:]
	V.G = regiongraphs.make_graph(V.vertices,V.edges)
	V.full_G = regiongraphs.make_graph(V.vertices, V.full_edges)
	V.changed_list = []
	close=lambda x,y: V.full_G.has_edge(x,y)

	if analyze_run:
		proofread_edges = h5read(os.path.join(V.directory, "proofread_edges.h5"), force=True)
		V.proofread_G = regiongraphs.make_graph(V.vertices, proofread_edges)

	for epoch in xrange(N_EPOCHS):
		V.changed = np.zeros(V.full_size, dtype=np.uint8)
		V.visited = np.zeros(V.full_size, dtype=np.float32)
		sort_samples(V)
		n_errors = len(V.weights)-np.searchsorted(V.weights[::-1],0.5)
		print(str(n_errors) + " errors")
		for I in xrange(0,min(N_STEPS,n_errors),RANDOMIZE_BATCH):
			shuff = np.arange(RANDOMIZE_BATCH)
			np.random.shuffle(shuff)
			for j in shuff:
				i=I+j
				print(i)
				try:
					tic()
					pos=perturb(V.samples[i,:],V)
					region = get_region(V,pos)
					cutout=SubVolume(V,region)
					if (V.visited[tuple(pos)] >= 1):
						raise ReconstructionException("Already visited here")
					V.visited[tuple(pos)] += 1
					if V.raw_labels[tuple(pos)] in V.glial:
						raise ReconstructionException("glia; not growing")
					toc("cutout")

					tic()
					#check if segment leaves window. If not, don't grow it.
					central_segment = bfs(cutout.G,[V.raw_labels[tuple(pos)]])
					central_segment_mask = indicator(cutout.raw_labels,central_segment)
					central_segment_bbox = ndimage.find_objects(central_segment_mask, max_label=1)[0]
					if all([x.stop-x.start < y for x,y in zip(central_segment_bbox,DUST_THRESHOLD)]):
						raise ReconstructionException("dust; not growing")
					toc("dust check")
					
					tic()
					current_segments = bfs(cutout.G,[V.raw_labels[tuple(pos)]]+cutout.local_errors(threshold=ERROR_THRESHOLD))
					toc("select neighbours")

					tic()
					cutout.mask=indicator(cutout.raw_labels,current_segments)
					cutout.central_supervoxel = indicator(cutout.raw_labels,[V.raw_labels[tuple(pos)]])
					cutout.current_object
					toc("gen masks")

					tic()
					cutout.traced = reconstruct_utils.trace_daemon(cutout.image, cutout.mask, cutout.central_supervoxel)
					toc("tracing")

					if analyze_run:
						tic()
						df_segments_next, df_examples_next = analyze(cutout,i)
						df_segments = df_segments.append(df_segments_next)
						df_examples = df_examples.append(df_examples_next)
						toc("analysis")

					if not dry_run:
						tic()
						tmp=commit(cutout, close=close)
						if tmp:
							V.changed_list.append(V.samples[i:i+1,:])
						toc("commit")

					tic()
					visited_cutout = indicator(cutout.raw_labels, bfs(cutout.G, [V.raw_labels[tuple(pos)]]))
					subregion = crop_region(patch_size,VISITED_CROP)
					V.visited[cutout.region][subregion] += visited_cutout[subregion]
					toc("recording visit")

					print("Committed!")
				except ReconstructionException as e:
					print(e)
					misc_utils.tics=[]
					"""
					if e.message != "out of bounds":
						visited_cutout = indicator(cutout.raw_labels, bfs(cutout.G, [V.raw_labels[tuple(pos)]]))
						subregion = crop_region(patch_size,VISITED_CROP)
						V.visited[cutout.region][subregion] += 0.3*visited_cutout[subregion]
					"""

				if analyze_run and i%100 == 0:
					df_segments.to_pickle(os.path.join(logdir,"segments.pickle"))
					df_examples.to_pickle(os.path.join(logdir,"examples.pickle"))
				if i % 1000 == 0 and logdir is not None:
					h5write(os.path.join(logdir,"epoch"+str(epoch)+"_edges.h5"), V.G.edges())
					h5write(os.path.join(logdir,"epoch"+str(epoch)+"_changed_list.h5"), np.concatenate(V.changed_list+[np.zeros((0,3))],axis=0))
		if logdir is not None:
			h5write(os.path.join(logdir,"epoch"+str(epoch)+"_edges.h5"), V.G.edges())
			h5write(os.path.join(logdir,"epoch"+str(epoch)+"_changed_list.h5"), np.concatenate(V.changed_list+[np.zeros((0,3))],axis=0))
		recompute_errors(V)
		if logdir is not None:
			h5write(os.path.join(logdir,"epoch"+str(epoch)+"_machine_labels.h5"), V.machine_labels)
			h5write(os.path.join(logdir,"epoch"+str(epoch)+"_errors.h5"), V.errors)
	return np.array(V.G.edges())

def reconstruct_wrapper(image, errors, watershed, affinities, samples, vertices, edges, full_edges, valid=set([]), glial=set([]), dendrite=set([])):
	V=Volume("", {
			"image": image,
			 "errors": errors,
			 "raw_labels": watershed,
			 "affinities": affinities,
			 "vertices": vertices,
			 "edges": edges,
			 "full_edges": full_edges,
			 "valid": valid,
			 "glial": glial,
			 "dendrite": dendrite,
			 "samples": samples,
		})
	return reconstruct_volume(V,dry_run=False,analyze_run=False, logdir=None)

if __name__ == "__main__":
	#basename = sys.argv[1]
	#basename=os.path.expanduser("/mnt/data01/jzung/pinky40_test")
	basename=os.path.expanduser("~/mydatasets/3_3_1")
	#basename=os.path.expanduser("~/mydatasets/2_3_1")
	#basename=os.path.expanduser("~/mydatasets/golden")

	print("loading files...")
	V = Volume(basename,
			{"image": "image.h5",
			 "errors": PARENT + "errors.h5",
			 "raw_labels": "raw.h5",
			 "affinities": "aff.h5",
			 #"human_labels": "proofread.h5",
			 "vertices": "vertices.h5",
			 "edges": PARENT + "edges.h5",
			 "full_edges": "full_edges.h5",
			 "valid": set([]),
			 #"glial": set([30437,8343897,4322435,125946,8244754,4251447,8355342,5551,4346675,8256784,118018,8257243,20701,2391,4320,8271859,4250078]),
			 #"glial": set([2]),
			 "glial": set([]),
			 "dendrite": set([]),
			 "axon": set([]),
			 "samples": "samples.h5",
			 })
	print("done")
	date = datetime.now().strftime("%j-%H-%M-%S")
	reconstruct_volume(V,dry_run=False,analyze_run=False, logdir=os.path.join(basename,date))
	#edges = h5write(os.path.join(basename,"revised_edges.h5"),reconstruct_volume(V))


import networkx as nx
import numpy as np
from tqdm import tqdm

G = nx.Graph()
first_line = True
with open('rg_volume.in') as f:
    for line in tqdm(f):
        if first_line: #ignore the first line
            first_line = False
            continue

        u, v, aff_sum, aff_count, _,_,_,_,_ =  line.split(' ')
        u = np.uint32(u)
        v = np.uint32(v)
        aff_sum = np.float32(aff_sum) 
        aff_count = np.float32(aff_count)
        G.add_edge(u,v, capacity=aff_sum/aff_count)

nx.write_gpickle(G,"s1_graph.pickle")

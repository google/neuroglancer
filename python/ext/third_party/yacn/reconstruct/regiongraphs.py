import networkx as nx

def make_graph(vertices, edges): 
	G=nx.Graph()
	G.add_nodes_from(vertices)
	G.add_edges_from(edges)
	return G


def add_clique(G, vertices, guard = lambda x,y: True):
	for i in xrange(len(vertices)):
		for j in xrange(i,len(vertices)):
			if guard(vertices[i],vertices[j]):
				G.add_edge(vertices[i],vertices[j])
	
def delete_bipartite(G, vertices1, vertices2):
	for v1 in vertices1:
		for v2 in vertices2:
			if G.has_edge(v1,v2):
				#print "deleted edge", v1, v2
				G.remove_edge(v1,v2)

def update_weights_clique(G, vertices, weights):
	for i in xrange(len(vertices)):
		for j in xrange(i,len(vertices)):
			v1=vertices[i]
			v2=vertices[j]
			if G.has_edge(v1,v2):
				G[v1][v2]['weight']+=weights[vi]*weights[vj]
				#G[v1][v2]['count']+=weights[vi]*weights[vj] + (1-weights[vi])*weights[vj] + weights[vi]*(1-weights[vj])
				G[v1][v2]['count']+=weights[vi]+weights[vj] - weights[vi]*weights[vj]

def bfs(G,l):
	return set(_plain_bfs(G,l))

def _plain_bfs(G, sources):
    seen = set()
    nextlevel = set(sources)
    while nextlevel:
        thislevel = nextlevel
        nextlevel = set()
        for v in thislevel:
            if v not in seen:
                yield v
                seen.add(v)
                nextlevel.update(G[v])
"""
def expand_list(G,l):
	s=set()
	return list(s.union(*[nx.node_connected_component(G, x) for x in l]))
"""

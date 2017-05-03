import threading
import json
from weakref import WeakValueDictionary

import tornado.ioloop
import tornado.web
from tornado import httpserver, netutil

import networkx as nx
import numpy as np
import ssl

class BaseHandler(tornado.web.RequestHandler):
	def initialize(self, G):
		self.G = G

	def add_cors_headers(self):
		self.set_header("Access-Control-Allow-Origin", "*")
		self.set_header("Access-Control-Allow-Headers", "x-requested-with")
		self.set_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')

	def prepare(self):
		self.add_cors_headers()

class NodeHandler(BaseHandler):
	def get(self, u):
		u = int(u)
		print(u)
		if self.G.has_node(u):
			nodes = node_connected_component(self.G, u)
			data = np.array(list(nodes)).astype(np.uint32).tostring()
			self.write(data)

		else:
			self.G.add_node(u)
			self.write('')

	def post(self, u):
		u = int(u)

		self.G.add_node(u)
		self.set_status(200)
		self.finish()

	def delete(self, u):
		u = int(u)
		
		if self.G.has_node(u):
			self.G.remove_node(u)
			self.clear()
			self.set_status(200)
			self.finish()
		else:
			self.clear()
			self.set_status(400)
			self.finish()
def make_app(G):
	args =  {
		'G': G,
	}

	app = tornado.web.Application([
		(r'/1.0/node/(\d+)/?', NodeHandler, args),
	], debug=True)

	app.args = args
	return app

def start_server(G):
	app = make_app(G)
	http_server = tornado.httpserver.HTTPServer(app)
	http_server.bind(8088)
	http_server.start(1)
	#tornado.ioloop.IOLoop.current().start()

	#thread = threading.Thread(target=tornado.ioloop.IOLoop.instance().start)
	#thread.daemon = True
	#thread.start()

	# 0: ('::', 53044, 0, 0)
	# 1: ('0.0.0.0', 53286)

	return 'http://localhost:%s' % 8088

if __name__ == '__main__':
	start_server(nx.Graph())

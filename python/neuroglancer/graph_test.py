import json

import networkx as nx
from tornado.testing import AsyncHTTPTestCase

from graph_server import make_app

class BaseTestCase(AsyncHTTPTestCase):
    def get_app(self):
        self.app =  make_app(test=True)
        return self.app

    def tearDown(self):
        self.app.args['G'] = nx.Graph()
        del self.app.args['sets'][:]

    @property
    def G(self):
        return self.app.args['G']

    @G.setter
    def G(self, value): 
        self.app.args['G'] = value

    def check_get_object(self, arr):
        self.http_client.fetch(
            self.get_url('/1.0/object/'),
            self.stop,
            method="GET"
        )
        response = self.wait()
        self.assertEquals(json.loads(response.body), arr)

    def check_post_object(self, arr):
        self.http_client.fetch(
            self.get_url('/1.0/object/'),
            self.stop,
            body=json.dumps(arr),
            method="POST"
        )
        response = self.wait()
        self.assertEqual(response.code, 200)

class TestSplitHandler(BaseTestCase):
    
    def test_split_center(self):
        self.check_post_object([1,2,3,4])
        self.G.add_edge(1,2,capacity=0.5)
        self.G.add_edge(2,3,capacity=0.1)
        self.G.add_edge(3,4,capacity=0.5)

        self.http_client.fetch(
            self.get_url('/1.0/split/'),
            self.stop,
            body=json.dumps({'sources':[1], 'sinks':[4]}),
            method="POST"
        )
        response = self.wait()
        self.assertEqual(response.code, 200)

        set_response = set(map(tuple, json.loads(response.body)))
        self.assertEqual(set_response, set([(1,2),(3,4)]))

    def test_split_side(self):
        self.check_post_object([1,2,3,4])
        self.G.add_edge(1,2,capacity=0.5)
        self.G.add_edge(2,3,capacity=0.8)
        self.G.add_edge(3,4,capacity=0.5)

        self.http_client.fetch(
            self.get_url('/1.0/split/'),
            self.stop,
            body=json.dumps({'sources':[1], 'sinks':[4]}),
            method="POST"
        )
        response = self.wait()
        self.assertEqual(response.code, 200)

        set_response = set(map(tuple, json.loads(response.body)))
        left = set_response == set([(1,2,3),(4,)])
        right = set_response == set([(1,),(2, 3, 4)])
        self.assertTrue(left or right)

        

    def test_split_outsider(self):
        self.check_post_object([1,2,3,4])
        self.G.add_edge(1,2,capacity=0.5)
        self.G.add_edge(2,3,capacity=0.8)
        self.G.add_edge(3,4,capacity=0.5)

        self.http_client.fetch(
            self.get_url('/1.0/split/'), #8 is not inside object
            self.stop,
            body=json.dumps({'sources':[1], 'sinks':[8]}),
            method="POST"
        )
        response = self.wait()
        self.assertEqual(response.code, 400)


    def test_overlapping_sink_and_source(self):
        self.check_post_object([1,2,3,4])
        self.G.add_edge(1,2,capacity=0.5)
        self.G.add_edge(2,3,capacity=0.8)
        self.G.add_edge(3,4,capacity=0.5)

        self.http_client.fetch(
            self.get_url('/1.0/split/'), #8 is not inside object
            self.stop,
            body=json.dumps({'sources':[1,2], 'sinks':[2]}),
            method="POST"
        )
        response = self.wait()
        self.assertEqual(response.code, 400)


    def test_multisplit(self):
        self.check_post_object([1,2,3,4])
        self.G.add_edge(1,2,capacity=0.1)
        self.G.add_edge(2,3,capacity=0.8)
        self.G.add_edge(3,4,capacity=0.1)

        self.http_client.fetch(
            self.get_url('/1.0/split/'),
            self.stop,
            body=json.dumps({'sources':[1,2], 'sinks':[3,4]}),
            method="POST"
        )
        response = self.wait()
        self.assertEqual(response.code, 200)

        tuple_response = map(tuple, json.loads(response.body))
        self.assertEqual(set(tuple_response), set([(1,2),(3,4)]))

    def test_disconnected_subgraphs(self):
        self.check_post_object([1,2,3,4])
        self.G.add_edge(1,2,capacity=0.1)
        self.G.add_edge(3,4,capacity=0.1)
        self.http_client.fetch(
            self.get_url('/1.0/split/'),
            self.stop,
            body=json.dumps({'sources':[1], 'sinks':[4]}),
            method="POST"
        )
        response = self.wait()
        self.assertEqual(response.code, 200)

        tuple_response = map(tuple, json.loads(response.body))
        self.assertEqual(set(tuple_response), set([(1,2),(3,4)]))

    def test_three_disconnected_subgraphs(self):
        """
        The source partition should be of minimal size in case of 
        many subgraphs
        """
        self.check_post_object([1,2,3,4,5,6])
        self.G.add_edge(1,2,capacity=0.1)
        self.G.add_edge(3,4,capacity=0.1)
        self.G.add_edge(5,6,capacity=0.1)
        self.G.add_edge(7,8,capacity=0.1)

        self.http_client.fetch(
            self.get_url('/1.0/split/'),
            self.stop,
            body=json.dumps({'sources':[1], 'sinks':[4]}),
            method="POST"
        )
        response = self.wait()
        self.assertEqual(response.code, 200)

        tuple_response = map(tuple, json.loads(response.body))
        self.assertEqual(set(tuple_response), set([(1,2),(3,4,5,6)]))


class TestObjectHandler(BaseTestCase):

    def test_empty(self):
        self.check_post_object([])

    def test_insertion(self):
        self.check_post_object([1,2,3])
        self.check_get_object([[1,2,3]])

        # adds the same stuff once again
        self.check_post_object([1,2,3])
        self.check_get_object([[1,2,3]])

        # adds an independent objects
        self.check_post_object([4,5,6])
        self.check_get_object([[1,2,3],[4,5,6]])

        # adds another set that merges the two objects from before
        self.check_post_object([5,6,1,7])
        self.check_get_object([[1,2,3,4,5,6,7]])

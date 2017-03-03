from tornado import web, ioloop, httpserver
from sockjs.tornado import SockJSConnection, SockJSRouter
import json 
from collections import OrderedDict

clients = set()
n_messages = 0
class Connection(SockJSConnection):
    def on_open(self, info):
        """
        info is an object which contains caller IP address, query string
        parameters and cookies associated with this request"""
        # When new client comes in, will add it to the clients list
        clients.add(self)
       
    def on_message(self, json_state):
        """
        This will call initialize_state or on_state_change depening on if it is
        the first message recieved.
        """
        state = json.JSONDecoder(object_pairs_hook=OrderedDict).decode(json_state)
        global n_messages

        if not n_messages: #first message ever
            new_state = self.initialize_state(state)
        else:
            new_state = self.on_state_change(state)

        n_messages += 1
        if new_state: #if you return a new state send it back
            self.broadcast(clients, json.dumps(new_state))
        
        
    def on_close(self):
        # If client disconnects, remove him from the clients list
        clients.remove(self)

    def initialize_state(self, state):
        """
        This is called once the connection is stablished.
        """
        pass

    def on_state_change(self, state):
        """
        This is called every time there is a new state available
        (except the very first time).
        """
        print(state)

# In order for the webbrowser to connect to this server
# add to the url 'stateURL':'http://localhost:9999'
router = SockJSRouter(Connection)
def broadcast(state):
    """
    Use this method to broadcast a new state to all connected clients.
    Without the need to wait for an `on_state_change`.
    """
    router.broadcast(clients, json.dumps(state))


socketApp = web.Application(router.urls)
http_server = httpserver.HTTPServer(socketApp, ssl_options={
    "certfile": "./certificate.crt",
    "keyfile": "./privateKey.key",
})
http_server.bind(9999) #port
http_server.start(1)
ioloop.IOLoop.instance().start()
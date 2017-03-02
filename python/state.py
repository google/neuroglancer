from tornado import web, ioloop
from sockjs.tornado import SockJSConnection, SockJSRouter
import json 
from collections import OrderedDict

class Connection(SockJSConnection):

    def __init__(self, *args, **kwargs):
        self.clients = set()
        self.last_state = None
        super(Connection, self).__init__(*args, **kwargs)

    def on_open(self, msg):
        # When new client comes in, will add it to the clients list
        self.clients.add(self)
       
    def on_message(self, msg):
        state = json.JSONDecoder(object_pairs_hook=OrderedDict).decode(msg)
        
        if not self.last_state:
            new_state = self.initialize_state(state)
            if new_state:
                self.broadcast(self.clients, json.dumps(state))
                state = new_state
        else:
            new_state = self.on_state_change(state) 
            if new_state:
                self.broadcast(self.clients, json.dumps(state))
                state = new_state

        self.last_state = state

        
    def on_close(self):
        # If client disconnects, remove him from the clients list
        self.clients.remove(self)

    def initialize_state(self, state):
        """
        This is called once the connection is stablished
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
    router.broadcast(Connection.clients, json.dumps(state))


socketApp = web.Application(router.urls)
socketApp.listen(port=9999)
ioloop.IOLoop.instance().start()

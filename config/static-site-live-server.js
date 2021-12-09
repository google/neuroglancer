/**
 * @license
 * Copyright 2020 Google LLC
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';


// Serves a directory of static files, with programmatic control to force a
// browser reload.

// Derived from https://github.com/tapio/live-server
// License
// Uses MIT licensed code from Connect and Roots.

// (MIT License)

// Copyright (c) 2012 Tapio Vierros

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

var fs = require('fs'),
  connect = require('connect'),
  logger = require('morgan'),
  WebSocket = require('faye-websocket'),
  path = require('path'),
  url = require('url'),
  http = require('http'),
  send = require('send'),
  es = require("event-stream"),
  os = require('os');
require('colors');

const getInjectedCode = (initialGeneration) => `<!-- Code injected by static-site-live-server -->
<script type="text/javascript">
  // <![CDATA[  <-- For SVG support
  (function() {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') {
      return;
    }
    var generation = ${JSON.stringify(initialGeneration)};
    var protocol = window.location.protocol === 'http:' ? 'ws://' : 'wss://';
    var address = protocol + window.location.host + window.location.pathname + '/ws';
    function start() {
      var socket = new WebSocket(address);
      socket.onmessage = function(msg) {
        var newGeneration = msg.data;
        if (typeof newGeneration !== 'string') return;
        if (generation === newGeneration) return;
        window.location.reload();
      };
      socket.onclose = function() {
        console.log('Live reload connection lost.');
        setTimeout(start, 1000);
      };
      socket.onopen = function() {
        console.log('Live reload enabled.');
      };
    }
    start();
  })();
  // ]]>
</script>
`;

/**
 * Rewrite request URL and pass it back to the static handler.
 * @param staticHandler {function} Next handler
 * @param file {string} Path to the entry point file
 */
function entryPoint(staticHandler, file) {
  if (!file) return function(req, res, next) { next(); };

  return function(req, res, next) {
    req.url = "/" + file;
    staticHandler(req, res, next);
  };
}

class LiveServer {

  constructor(options = {}) {
    this.generation = '';
    this.logLevel = 2;
    this.clients = [];
  }

  // Based on connect.static(), but streamlined and with added code injecter
  staticServer(root) {
    var isFile = false;
    try {  // For supporting mounting files instead of just directories
      isFile = fs.statSync(root).isFile();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      var reqpath = isFile ? '' : url.parse(req.url).pathname;
      var hasNoOrigin = !req.headers.origin;
      var injectCandidates =
          [new RegExp('</body>', 'i'), new RegExp('</svg>'), new RegExp('</head>', 'i')];
      var injectTag = null;
      var fileExt = "";

      const directory = () => {
        var pathname = url.parse(req.originalUrl).pathname;
        res.statusCode = 301;
        res.setHeader('Location', pathname + '/');
        res.end('Redirecting');
      };

      const file = (filepath /*, stat*/) => {
        fileExt = path.extname(filepath).toLocaleLowerCase();
        var possibleExtensions = [ "", ".html", ".htm", ".xhtml", ".php", ".svg" ];

        if (hasNoOrigin && (possibleExtensions.indexOf(fileExt) > -1)) {
          // TODO: Sync file read here is not nice, but we need to determine if the html should be
          // injected or not
          var contents = fs.readFileSync(filepath, 'utf8');
          for (var i = 0; i < injectCandidates.length; ++i) {
            let match = injectCandidates[i].exec(contents);
            if (match) {
              injectTag = match[0];
              break;
            }
          }
          if (injectTag === null && this.logLevel >= 3) {
            console.warn(
                'Failed to inject refresh script!'.yellow, 'Couldn\'t find any of the tags ',
                injectCandidates, 'from', filepath);
          }
        }
      };

      const error = (err) => {
        if (err.status === 404) return next();
        next(err);
      };

      const inject = (stream) => {
        if (fileExt == ".wasm") {
          res.setHeader('Content-Type', 'application/wasm');
        }
        if (injectTag) {
          const injectedCode = getInjectedCode(this.generation);
          // We need to modify the length given to browser
          var len = injectedCode.length + res.getHeader('Content-Length');
          res.setHeader('Content-Length', len);
          var originalPipe = stream.pipe;
          stream.pipe = function(resp) {
            originalPipe
                .call(stream, es.replace(new RegExp(injectTag, 'i'), injectedCode + injectTag))
                .pipe(resp);
          };
        }
      };

      send(req, reqpath, {root: root})
          .on('error', error)
          .on('directory', directory)
          .on('file', file)
          .on('stream', inject)
          .pipe(res);
    };
  }

  /**
   * Start a live server with parameters given as an object
   * @param host {string} Address to bind to (default: 0.0.0.0)
   * @param port {number} Port number (default: 8080)
   * @param root {string} Path to root directory (default: cwd)
   * @param mount {array} Mount directories onto a route, e.g. [['/components', './node_modules']].
   * @param logLevel {number} 0 = errors only, 1 = some, 2 = lots
   * @param file {string} Path to the entry point file
   *     }].
   */
  start(options = {}) {
    var host = options.host || '0.0.0.0';
    var port = options.port !== undefined ? options.port : 8080;  // 0 means random
    var root = options.root || process.cwd();
    var mount = options.mount || [];
    this.logLevel = options.logLevel === undefined ? 2 : options.logLevel;
    var file = options.file;
    var staticServerHandler = this.staticServer(root);

    // Setup a web server
    var app = connect();

    // Add logger. Level 2 logs only errors
    if (this.logLevel === 2) {
      app.use(logger('dev', {
        skip: function(req, res) {
          return res.statusCode < 400;
        }
      }));
      // Level 2 or above logs all requests
    } else if (this.logLevel > 2) {
      app.use(logger('dev'));
    }
    mount.forEach(function(mountRule) {
      var mountPath = path.resolve(process.cwd(), mountRule[1]);
      app.use(mountRule[0], this.staticServer(mountPath));
      if (this.logLevel >= 1) console.log('Mapping %s to "%s"', mountRule[0], mountPath);
    });
    app.use(staticServerHandler)  // Custom static server
        .use(entryPoint(staticServerHandler, file));

    var server = http.createServer(app);
    var protocol = 'http';

    // Handle server startup errors
    server.addListener('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        var serveURL = protocol + '://' + host + ':' + port;
        console.log('%s is already in use. Trying another port.'.yellow, serveURL);
        setTimeout(function() {
          server.listen(0, host);
        }, 1000);
      } else {
        console.error(e.toString().red);
        this.shutdown();
      }
    });

    // Handle successful server
    server.addListener('listening', (/*e*/) => {
      this.server = server;

      var address = server.address();
      var serveHost = address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
      var openHost = host === '0.0.0.0' ? '127.0.0.1' : host;

      var serveURL = protocol + '://' + serveHost + ':' + address.port;
      var openURL = protocol + '://' + openHost + ':' + address.port;

      var serveURLs = [serveURL];
      if (this.logLevel > 2 && address.address === '0.0.0.0') {
        var ifaces = os.networkInterfaces();
        serveURLs = Object.keys(ifaces)
                        .map(function(iface) {
                          return ifaces[iface];
                        })
                        // flatten address data, use only IPv4
                        .reduce(
                            function(data, addresses) {
                              addresses
                                  .filter(function(addr) {
                                    return addr.family === 'IPv4';
                                  })
                                  .forEach(function(addr) {
                                    data.push(addr);
                                  });
                              return data;
                            },
                            [])
                        .map(function(addr) {
                          return protocol + '://' + addr.address + ':' + address.port;
                        });
      }

      // Output
      if (this.logLevel >= 1) {
        if (serveURL === openURL)
          if (serveURLs.length === 1) {
            console.log(('Serving "%s" at %s').green, root, serveURLs[0]);
          } else {
            console.log(('Serving "%s" at\n\t%s').green, root, serveURLs.join('\n\t'));
          }
        else
          console.log(('Serving "%s" at %s (%s)').green, root, openURL, serveURL);
      }
    });

    // Setup server to listen at port
    server.listen(port, host);

    // WebSocket
    server.addListener('upgrade', (request, socket, head) => {
      var ws = new WebSocket(request, socket, head);
      ws.onopen = () => {
        ws.send(this.generation);
      };

      ws.onclose = () => {
        this.clients = this.clients.filter(function(x) {
          return x !== ws;
        });
      };

      this.clients.push(ws);
    });
    this.server = server;
    return server;
  }

  reload() {
    this.generation = '' + Math.random();
    this.clients.forEach((ws) => {
      if (ws) ws.send(this.generation);
    });
  }

  shutdown() {
    if (this.server) {
      this.server.close();
    }
  }
}

module.exports = LiveServer;

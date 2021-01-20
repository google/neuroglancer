// Copyright 2020 Google Inc.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package main

import (
	"context"
	"log"
	"net/http"
	"os"

	gorilla_handlers "github.com/gorilla/handlers"
	gorilla_mux "github.com/gorilla/mux"
)

func main() {

	ctx := context.Background()

	authenticator, err := MakeAuthenticator(ctx)
	if err != nil {
		panic(err)
	}

	mux := gorilla_mux.NewRouter()
	if os.Getenv("GAE_INSTANCE") != "" || os.Getenv("K_SERVICE") != "" {
		// When running on AppEngine or Cloud Run, trust the reverse proxy to provide the real scheme and hostname.
		mux.Use(gorilla_handlers.ProxyHeaders)
	}
	mux.PathPrefix("/").Handler(authenticator.Router())

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
		log.Printf("Defaulting to port %s", port)
	}

	log.Printf("Listening on port %s", port)
	if err := http.ListenAndServe(":"+port, gorilla_handlers.RecoveryHandler()(mux)); err != nil {
		log.Fatal(err)
	}
}

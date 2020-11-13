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
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"net/url"
)

type CredentialAccessBoundary struct {
	AccessBoundary AccessBoundary `json:"accessBoundary"`
}

type AccessBoundary struct {
	AccessBoundaryRules []AccessBoundaryRule `json:"accessBoundaryRules"`
}

type AvailabilityCondition struct {
	Title      string `json:"title,omitempty"`
	Expression string `json:"expression,omitempty"`
}

type AccessBoundaryRule struct {
	AvailableResource     string                 `json:"availableResource"`
	AvailablePermissions  []string               `json:"availablePermissions"`
	AvailabilityCondition *AvailabilityCondition `json:"availabilityCondition,omitempty"`
}

type DownscopedTokenResponse struct {
	AccessToken     string `json:"access_token"`
	IssuedTokenType string `json:"issued_token_type"`
	TokenType       string `json:"token_type"`
	ExpiresIn       int    `json:"expires_in"`
}

func (auth *Authenticator) generateBoundedAccessToken(bucket string) (token string, err error) {
	// https://cloud.google.com/iam/docs/downscoping-short-lived-credentials?hl=en#create-credential
	postReq := url.Values{}
	boundary := CredentialAccessBoundary{
		AccessBoundary: AccessBoundary{
			AccessBoundaryRules: []AccessBoundaryRule{
				AccessBoundaryRule{
					AvailableResource: getBucketResourceName(bucket),
					AvailablePermissions: []string{
						"inRole:roles/storage.objectViewer",
					},
				},
			},
		},
	}
	boundaryJson, err := json.Marshal(boundary)
	if err != nil {
		return
	}
	postReq.Set("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange")
	postReq.Set("options", url.QueryEscape(string(boundaryJson)))
	postReq.Set("requested_token_type", "urn:ietf:params:oauth:token-type:access_token")
	origToken, err := auth.Credentials.TokenSource.Token()
	if err != nil {
		return
	}
	postReq.Set("subject_token", origToken.AccessToken)
	postReq.Set("subject_token_type", "urn:ietf:params:oauth:token-type:access_token")
	resp, err := http.PostForm("https://sts.googleapis.com/v1beta/token", postReq)
	defer resp.Body.Close()
	if err != nil {
		return
	}
	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := ioutil.ReadAll(resp.Body)
		err = fmt.Errorf("Unable to exchange token: %v %v %v", resp.StatusCode, resp.Status, string(bodyBytes))
		return
	}
	var respMsg DownscopedTokenResponse
	err = json.NewDecoder(resp.Body).Decode(&respMsg)
	if err != nil {
		return
	}
	token = respMsg.AccessToken
	return
}

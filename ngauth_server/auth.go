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
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"io/ioutil"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	gorilla_mux "github.com/gorilla/mux"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/idtoken"
	"google.golang.org/api/option"
	"google.golang.org/api/transport"
	policytroubleshooterpb "google.golang.org/genproto/googleapis/cloud/policytroubleshooter/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

type Authenticator struct {
	ProjectID            string
	Credentials          *google.Credentials
	OAuth2Config         *oauth2.Config
	AllowedOriginPattern *regexp.Regexp

	// HMAC key for authenticating user login tokens
	UserTokenKey []byte

	GoogleHttpClient *http.Client
}

func (auth *Authenticator) validateIdToken(ctx context.Context, idToken string) (userId string, err error) {
	payload, err := idtoken.Validate(ctx, idToken, auth.OAuth2Config.ClientID)
	if err != nil {
		err = fmt.Errorf("Invalid id_token: %w", err)
		return
	}
	switch v := payload.Claims["email"].(type) {
	case string:
		userId = v
		break
	default:
		err = fmt.Errorf("id_token is missing email")
		return
	}
	switch v := payload.Claims["email_verified"].(type) {
	case bool:
		if !v {
			err = fmt.Errorf("id_token is is missing verified_email")
			return
		}
		break
	default:
		err = fmt.Errorf("id_token is is missing verified_email")
		return
	}
	return
}

func (auth *Authenticator) extractAndValidateIdToken(ctx context.Context, token *oauth2.Token) (idToken string, userId string, err error) {
	idToken, ok := token.Extra("id_token").(string)
	if !ok {
		err = fmt.Errorf("Missing id_token")
		return
	}
	userId, err = auth.validateIdToken(ctx, idToken)
	if err != nil {
		return
	}
	return
}

// 1 year
const MaxUserTokenCookieLifetimeSeconds = 60 * 60 * 24 * 365

// 1 hour
const MaxUserTokenCrossOriginLifetimeSeconds = 60 * 60

func makeTemporaryUserToken(token UserToken) UserToken {
	newExpires := time.Now().Unix() + MaxUserTokenCrossOriginLifetimeSeconds
	if newExpires < token.Expires {
		token.Expires = newExpires
	}
	return token
}

func getEnvOr(key string, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

const MacKeyMinLength = 32

const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform"

func MakeAuthenticator(ctx context.Context) (*Authenticator, error) {
	auth := &Authenticator{}

	options := []option.ClientOption{option.WithScopes(cloudPlatformScope)}
	if impersonateServiceAccount, ok := os.LookupEnv("IMPERSONATE_SERVICE_ACCOUNT"); ok {
		options = append(options, option.ImpersonateCredentials(impersonateServiceAccount))
	}
	credentials, err := transport.Creds(ctx, options...)
	if err != nil {
		return nil, err
	}
	auth.Credentials = credentials

	// Decode oauth2 credentials
	clientCredentialsPath := getEnvOr("OAUTH2_CLIENT_CREDENTIALS_PATH", "secrets/client_credentials.json")
	clientCredentials, err := ioutil.ReadFile(clientCredentialsPath)
	if err == nil {
		auth.OAuth2Config, err = google.ConfigFromJSON(clientCredentials)
	}
	if err != nil {
		return nil, fmt.Errorf("Error reading client credentials from %s: %w", clientCredentialsPath, err)
	}

	// Decode allowed origins
	allowedOriginsPath := getEnvOr("ALLOWED_ORIGINS_PATH", "secrets/allowed_origins.txt")
	allowedOriginsPattern, err := ioutil.ReadFile(allowedOriginsPath)
	if err == nil {
		auth.AllowedOriginPattern, err = regexp.Compile(strings.TrimSpace(string(allowedOriginsPattern)))
	}
	if err != nil {
		return nil, fmt.Errorf("Error reading allowed origins from %s: %w", allowedOriginsPath, err)
	}

	// Decode login session encryption key
	loginHmacKeyPath := getEnvOr("LOGIN_SESSION_HMAC_KEY_PATH", "secrets/login_session_key.dat")
	auth.UserTokenKey, err = ioutil.ReadFile(loginHmacKeyPath)
	if err != nil {
		return nil, fmt.Errorf("Error reading login session hmac key from %s: %w", loginHmacKeyPath, err)
	}
	if len(auth.UserTokenKey) < MacKeyMinLength {
		return nil, fmt.Errorf("Login session MAC key length (%d) is less than %d", len(auth.UserTokenKey), MacKeyMinLength)
	}

	// Initialize IamCheckerClient
	//auth.GoogleTokenSource, err = google.DefaultTokenSource(ctx, "https://www.googleapis.com/auth/cloud-platform")
	auth.GoogleHttpClient = oauth2.NewClient(ctx, auth.Credentials.TokenSource)
	// auth.IamCheckerClient, err = policytroubleshooter.NewIamCheckerClient(ctx)

	return auth, nil
}

type UserToken struct {
	UserId  string `json:"u"`
	Expires int64  `json:"e"`
}

const userTokenMacLength = 32

func computeUserTokenMac(key []byte, encodedJson []byte) []byte {
	hasher := hmac.New(sha256.New, key)
	hasher.Write(encodedJson)
	return hasher.Sum(nil)
}

func EncodeUserToken(key []byte, userToken UserToken) string {
	// Json encoding cannot fail
	encodedJson, _ := json.Marshal(userToken)
	return base64.StdEncoding.EncodeToString(append(computeUserTokenMac(key, encodedJson), encodedJson...))
}

func DecodeUserToken(key []byte, encryptedToken string) (userToken UserToken, err error) {
	encodedWithMac, err := base64.StdEncoding.DecodeString(encryptedToken)
	if err != nil {
		return
	}
	if len(encodedWithMac) < 32 {
		err = fmt.Errorf("User token length (%d) is less than MAC length (%d)", len(encodedWithMac), userTokenMacLength)
		return
	}
	storedMac := encodedWithMac[:userTokenMacLength]
	encodedJson := encodedWithMac[userTokenMacLength:]
	expectedMac := computeUserTokenMac(key, encodedJson)
	if !hmac.Equal(storedMac, expectedMac) {
		err = fmt.Errorf("Invalid MAC")
		return
	}
	err = json.Unmarshal(encodedJson, &userToken)
	if err != nil {
		return
	}
	if userToken.Expires < time.Now().Unix() {
		err = fmt.Errorf("Token expired")
		return
	}
	return
}

const UserTokenCookieName = "ngauth_login"

func (auth *Authenticator) IsOriginAllowed(origin string) bool {
	return auth.AllowedOriginPattern.MatchString(origin)
}

var OriginPattern = regexp.MustCompile("^https?:\\/\\/[a-zA-Z0-9\\-.]+(:\\d+)?$")

func GetOAuth2RedirectURI(r *http.Request) string {
	var u url.URL
	u.Scheme = r.URL.Scheme
	if u.Scheme == "" {
		u.Scheme = "http"
	}
	u.Host = r.Host
	u.Path = "/auth_redirect"
	return u.String()
}

func (auth *Authenticator) GetOAuth2Config(r *http.Request) *oauth2.Config {
	config := *auth.OAuth2Config
	config.RedirectURL = GetOAuth2RedirectURI(r)
	config.Scopes = []string{"email"}
	return &config
}

type GcsTokenRequest struct {
	Token  string `json:"token"`
	Bucket string `json:"bucket"`
}

type GcsTokenResponse struct {
	Token string `json:"token"`
}

func getBucketResourceName(bucket string) string {
	return "//storage.googleapis.com/projects/_/buckets/" + bucket
}

func (auth *Authenticator) checkStoragePermission(userId string, bucket string) (granted bool, err error) {
	policyRequest := policytroubleshooterpb.TroubleshootIamPolicyRequest{
		AccessTuple: &policytroubleshooterpb.AccessTuple{
			Principal:        userId,
			FullResourceName: getBucketResourceName(bucket),
			Permission:       "storage.objects.get",
		},
	}
	reqJson, err := protojson.Marshal(&policyRequest)
	if err != nil {
		return
	}
	resp, err := auth.GoogleHttpClient.Post("https://policytroubleshooter.googleapis.com/v1/iam:troubleshoot", "application/json", bytes.NewBuffer(reqJson))
	if err != nil {
		return
	}
	defer resp.Body.Close()
	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return
	}
	if resp.StatusCode != http.StatusOK {
		log.Printf("Error querying bucket %s user %s: %s %s", bucket, userId, resp.Status, string(body))
		granted = false
		return
	}
	var policyResponse policytroubleshooterpb.TroubleshootIamPolicyResponse
	err = protojson.UnmarshalOptions{
		DiscardUnknown: true,
	}.Unmarshal(body, &policyResponse)
	if err != nil {
		err = fmt.Errorf("Error unmarshaling body: %s %w", string(body), err)
		return
	}
	if policyResponse.Access == policytroubleshooterpb.AccessState_GRANTED {
		granted = true
	}
	return
}

func (auth *Authenticator) Router() *gorilla_mux.Router {
	mux := gorilla_mux.NewRouter()
	mux.Methods("GET").Path("/").HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("x-frame-options", "deny")
		w.Header().Add("content-type", "text/html")

		var userToken *UserToken
		if cookie, _ := r.Cookie(UserTokenCookieName); cookie != nil {
			token, err := DecodeUserToken(auth.UserTokenKey, cookie.Value)
			if err == nil {
				userToken = &token
			}
		}

		title := auth.Credentials.ProjectID
		if title == "" {
			title = "ngauth"
		}
		fmt.Fprintf(w, `<html><head><title>%s</title></head><body>`, html.EscapeString(title))
		defer fmt.Fprint(w, "</body></html>")

		if userToken == nil {
			fmt.Fprint(w, `Not logged in.  <a href="/login">Login</a>`)
			return
		}

		fmt.Fprintf(w, `Logged in as %s
<form action="/logout" method="post">
<input type="hidden" name="token" value="%s">
<input type="submit" value="Logout">
</form>
`, html.EscapeString(userToken.UserId), html.EscapeString(EncodeUserToken(auth.UserTokenKey, makeTemporaryUserToken(*userToken))))
	})

	mux.Methods("GET").Path("/login").HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.URL.Query().Get("origin")
		if !OriginPattern.MatchString(origin) {
			origin = ""
		}
		if origin != "" && !auth.IsOriginAllowed(origin) {
			jsonOrigin, err := json.Marshal(origin)
			if err != nil {
				// Marshal of a string cannot fail
				panic(err)
			}
			w.Header().Add("content-type", "text/html")
			fmt.Fprintf(w, `<html>
<body>
<script>
window.opener.postMessage("badorigin",%s);
window.close();
</script>
</body>
</html>`, jsonOrigin)
			return
		}
		http.Redirect(w, r, auth.GetOAuth2Config(r).AuthCodeURL(origin, oauth2.AccessTypeOffline), http.StatusFound)
	})

	mux.Methods("GET").Path("/auth_redirect").HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		origin := r.URL.Query().Get("state")
		if !auth.IsOriginAllowed(origin) {
			origin = ""
		}
		config := auth.GetOAuth2Config(r)
		token, err := config.Exchange(r.Context(), code)
		if err != nil {
			http.Error(w, "Invalid oauth2 code", http.StatusBadRequest)
			return
		}
		_, userId, err := auth.extractAndValidateIdToken(r.Context(), token)
		if err != nil {
			log.Printf("Invalid id token: %v", err)
			http.Error(w, "Invalid id token", http.StatusBadRequest)
			return
		}
		userToken := UserToken{
			UserId:  userId,
			Expires: time.Now().Unix() + MaxUserTokenCookieLifetimeSeconds,
		}
		cookie := &http.Cookie{
			Name:     UserTokenCookieName,
			Value:    EncodeUserToken(auth.UserTokenKey, userToken),
			HttpOnly: true,
			Expires:  time.Unix(userToken.Expires, 0),
		}
		if r.URL.Scheme == "https" {
			cookie.Secure = true
			cookie.SameSite = http.SameSiteNoneMode
		} else {
			cookie.SameSite = http.SameSiteLaxMode
		}
		http.SetCookie(w, cookie)
		if origin == "" {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		w.Header().Add("content-type", "text/html")
		jsonOrigin, err := json.Marshal(origin)
		if err != nil {
			panic(err)
		}
		tempUserToken := makeTemporaryUserToken(userToken)
		jsonToken, err := json.Marshal(map[string]string{
			"token": EncodeUserToken(auth.UserTokenKey, tempUserToken),
		})
		fmt.Fprintf(w, `<html>
<body>
<script>
window.opener.postMessage(%s,%s);
window.close();
</script>
</body>
</html>`, jsonToken, jsonOrigin)
	})

	mux.Methods("POST").Path("/logout").HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "Missing token", http.StatusBadRequest)
			return
		}
		var userTokenFromCookie *UserToken
		if cookie, _ := r.Cookie(UserTokenCookieName); cookie != nil {
			token, err := DecodeUserToken(auth.UserTokenKey, cookie.Value)
			if err == nil {
				userTokenFromCookie = &token
			}
		}

		var userTokenFromForm *UserToken
		if token, err := DecodeUserToken(auth.UserTokenKey, r.PostForm.Get("token")); err == nil {
			userTokenFromForm = &token
		}

		if userTokenFromCookie != nil && userTokenFromForm != nil && userTokenFromCookie.UserId == userTokenFromForm.UserId {
			http.SetCookie(w, &http.Cookie{
				Name:   UserTokenCookieName,
				MaxAge: -1,
			})
		}
		http.Redirect(w, r, "/", http.StatusFound)
	})

	mux.Methods("POST").Path("/token").HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("x-frame-options", "deny")
		origin := r.Header.Get("origin")
		if origin != "" {
			if !OriginPattern.MatchString(origin) {
				http.Error(w, "Missing Origin header", http.StatusBadRequest)
				return
			}
			w.Header().Set("access-control-allow-origin", origin)
			w.Header().Set("access-control-allow-credentials", "true")
			w.Header().Set("vary", "origin")
			if !auth.IsOriginAllowed(origin) {
				http.Error(w, "Origin not allowed", http.StatusForbidden)
				return
			}
		}
		var userToken *UserToken
		if cookie, _ := r.Cookie(UserTokenCookieName); cookie != nil {
			token, err := DecodeUserToken(auth.UserTokenKey, cookie.Value)
			if err == nil {
				userToken = &token
			} else {
				log.Printf("Received invalid token: %+v", err)
			}
		}
		if userToken == nil {
			http.Error(w, "Not logged in", http.StatusUnauthorized)
			return
		}
		encryptedToken := EncodeUserToken(auth.UserTokenKey, makeTemporaryUserToken(*userToken))
		w.Header().Add("content-type", "text/plain")
		fmt.Fprint(w, encryptedToken)
	})

	mux.Methods("POST").Path("/gcs_token").HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("origin")
		if origin != "" {
			w.Header().Set("access-control-allow-origin", origin)
			w.Header().Set("vary", "origin")
		}
		var tokenRequest GcsTokenRequest
		err := json.NewDecoder(r.Body).Decode(&tokenRequest)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		userToken, err := DecodeUserToken(auth.UserTokenKey, tokenRequest.Token)
		if err != nil {
			log.Printf("Invalid authentication token: %+v %+v %+v", r.Body, tokenRequest.Token, err)
			http.Error(w, "Invalid authentication token", http.StatusUnauthorized)
			return
		}
		granted, err := auth.checkStoragePermission(userToken.UserId, tokenRequest.Bucket)
		if err != nil {
			http.Error(w, "Failed to query bucket permissions", http.StatusInternalServerError)
			log.Printf("Error querying permissions, user=%s, bucket=%s, err=%+v", userToken.UserId, tokenRequest.Bucket, err)
			return
		}
		if !granted {
			http.Error(w, "Access denied", http.StatusForbidden)
			return
		}
		boundedToken, err := auth.generateBoundedAccessToken(tokenRequest.Bucket)
		if err != nil {
			http.Error(w, "Failed to obtain bounded oauth2 token", http.StatusInternalServerError)
			log.Printf("Error obtaining bounded token, bucket=%s, err=%+v", tokenRequest.Bucket, err)
			return
		}
		var tokenResponse GcsTokenResponse
		tokenResponse.Token = boundedToken
		tokenResponseJson, err := json.Marshal(&tokenResponse)
		if err != nil {
			http.Error(w, "Internal error", http.StatusInternalServerError)
			log.Printf("Error marshaling bounded token, bucket=%s, err=%+v", tokenRequest.Bucket, err)
		}
		w.Header().Set("content-type", "application/json")
		w.Write(tokenResponseJson)
	})
	return mux
}

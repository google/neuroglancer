Provides access to resources accessible via Globus.

---

The Globus datasource provides access to resources stored on storage systems configured with Globus Connect Server that support [HTTPS access](https://docs.globus.org/globus-connect-server/v5.4/https-access-collections/).

[Globus Auth](https://docs.globus.org/api/auth/) is used as the authorization mechanism for accessing resources.

When invoked, the `globus+https://` protocol will:

- When unauthententicated: Make a request to the Globus Connect Server HTTPS domain to determine required scopes.
- Initiate an OAuth2 flow to Globus Auth, using PKCE, to obtain an access token.
- Store the access token in `localStorage` for subsequent requests to the same resource server (Globus Connect Server instance).

## Configuration

A default Globus application Client ID (`GLOBUS_CLIENT_ID`) is provided by the Webpack configuration. The provided client will allow usage on `localhost`, **but will not work on other domains**. To use the Globus datasource on a different domain, you will need to [register your own Globus application](https://docs.globus.org/api/auth/developer-guide/#register-app), and provide the Client ID in the `GLOBUS_CLIENT_ID` environment variable.

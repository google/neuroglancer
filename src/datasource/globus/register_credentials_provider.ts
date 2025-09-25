import { registerDefaultCredentialsProvider } from "#src/credentials_provider/default_manager.js";
import { GlobusCredentialsProvider } from "#src/datasource/globus/credentials_provider.js";

export declare const GLOBUS_CLIENT_ID: string | undefined;

export function isGlobusEnabled() {
  return typeof GLOBUS_CLIENT_ID !== "undefined";
}

if (typeof GLOBUS_CLIENT_ID !== "undefined") {
  registerDefaultCredentialsProvider(
    "globus",
    (serverUrl) => new GlobusCredentialsProvider(GLOBUS_CLIENT_ID, serverUrl),
  );
}

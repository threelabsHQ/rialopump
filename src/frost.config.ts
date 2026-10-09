import { createConfig, getDefaultRialoClientConfig } from "@rialo/frost";

/**
 * Frost config — created once outside React, used by FrostProvider.
 * Points to Rialo Devnet.
 */
export const frostConfig = createConfig({
  clientConfig: getDefaultRialoClientConfig("devnet"),
  autoConnect: true,
});

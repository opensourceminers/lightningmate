/** Amboss endpoints, as the code under test calls them. The legacy endpoint
 *  serves only public market data now (getOffers, getMarketMetrics); every
 *  seller call goes to the Magma API — see helpers/magma.ts for its fake. */
export const AMBOSS_API = "https://api.amboss.space/graphql";
export { MAGMA_API } from "./magma.js";

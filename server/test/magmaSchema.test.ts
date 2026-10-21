/**
 * Every GraphQL document this app sends to magma.amboss.tech, checked against
 * the Magma schema saved from the live API (test/fixtures/magma-schema.json,
 * re-fetched 2026-10-20): every field, argument, input field and enum value
 * must exist, nothing deprecated may be used. Before, two buyer queries asked
 * for fields the schema doesn't have (`order.amount` on liquidity.buy, a bare
 * `amount` object on get_order) — a GraphQL validation error on every call,
 * found by nothing until a user tried to buy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as amboss from "../src/services/amboss.js";
import * as magmaApi from "../src/services/magmaApi.js";
import { ambossSpaceSchema, checkDocument, checkVariables, magmaSchema } from "./helpers/graphqlSchema.js";

const schema = magmaSchema();

/** The documents sent to the Magma API (OFFER_BOOK_QUERY goes to the legacy
 *  endpoint and is checked separately below). */
const MAGMA_DOCUMENTS: Record<string, string> = {
  PRICE_QUERY: amboss.PRICE_QUERY,
  PUBLIC_OFFERS_QUERY: amboss.PUBLIC_OFFERS_QUERY,
  BUY_LIQUIDITY_MUTATION: amboss.BUY_LIQUIDITY_MUTATION,
  BUYER_ORDER_QUERY: amboss.BUYER_ORDER_QUERY,
  BUY_FROM_OFFER_MUTATION: amboss.BUY_FROM_OFFER_MUTATION,
  CANCEL_PURCHASE_MUTATION: amboss.CANCEL_PURCHASE_MUTATION,
  MY_OFFER_IDS_QUERY: magmaApi.MY_OFFER_IDS_QUERY,
  MY_OFFER_QUERY: magmaApi.MY_OFFER_QUERY,
  CREATE_OFFER_MUTATION: magmaApi.CREATE_OFFER_MUTATION,
  UPDATE_OFFER_MUTATION: magmaApi.UPDATE_OFFER_MUTATION,
  TOGGLE_OFFER_MUTATION: magmaApi.TOGGLE_OFFER_MUTATION,
  SALES_QUERY: magmaApi.SALES_QUERY,
  SALE_QUERY: magmaApi.SALE_QUERY,
  ACCEPT_MUTATION: magmaApi.ACCEPT_MUTATION,
  ADD_TRANSACTION_MUTATION: magmaApi.ADD_TRANSACTION_MUTATION,
  REJECT_MUTATION: magmaApi.REJECT_MUTATION,
  KEY_CHECK_QUERY: magmaApi.KEY_CHECK_QUERY,
};

for (const [name, doc] of Object.entries(MAGMA_DOCUMENTS)) {
  test(`${name} matches the Magma schema`, () => {
    assert.deepEqual(checkDocument(schema, doc), []);
  });
}

test("the checker catches what it must: the old broken buy queries, deprecated fields, bad enums, bad variables", () => {
  const oldBuy = `mutation Buy($input: LiquidityOrderInput!) {
    liquidity { buy(input: $input) { order { transaction_id amount } payment { lightning_invoice amount { sats } } } }
  }`;
  assert.match(checkDocument(schema, oldBuy).join(), /LiquidityOrderDetails has no field "amount"/);
  const oldGetOrder = `query GetOrder($id: String!) { user { market { orders { get_order(order_id: $id) { status amount } } } } }`;
  assert.match(checkDocument(schema, oldGetOrder).join(), /needs a selection/);
  assert.match(
    checkDocument(schema, `query { user { market { orders { sales { list { id size } } } } } }`).join(),
    /deprecated/,
  );
  assert.match(
    checkDocument(schema, `query { user { market { orders { sales(input: { status: [NOPE] }) { total } } } } }`).join(),
    /not a MarketOrderStatus/,
  );
  // The legacy seller mutations simply don't exist on the Magma API.
  assert.notDeepEqual(checkDocument(schema, `mutation { sellerAcceptOrder(id: "x", request: "y") }`), []);
  // Variables: a required input field missing, a number where a String goes.
  assert.match(
    checkVariables(schema, magmaApi.ADD_TRANSACTION_MUTATION, { input: { order_id: "o" } }).join(),
    /missing|required/,
  );
  assert.match(checkVariables(schema, magmaApi.SALE_QUERY, { id: 42 }).join(), /not a String/);
});

test("what the app sends with each mutation fits the input types", () => {
  const cases: [string, Record<string, unknown>][] = [
    [magmaApi.ACCEPT_MUTATION, { input: { order_id: "o-1", payment_request: "lnbc1..." } }],
    [magmaApi.ADD_TRANSACTION_MUTATION, { input: { order_id: "o-1", tx_id: `${"aa".repeat(32)}:0` } }],
    [magmaApi.REJECT_MUTATION, { input: { order_id: "o-1" } }],
    [
      magmaApi.CREATE_OFFER_MUTATION,
      {
        input: {
          pubkey: "02" + "11".repeat(32),
          total_size: 5_000_000,
          min_size: 1_000_000,
          max_size: 5_000_000,
          fee_rate: 3000,
          base_fee: 852,
          min_block_length: 4320,
          fee_rate_cap: 2200,
          base_fee_cap: 1,
        },
      },
    ],
    [magmaApi.UPDATE_OFFER_MUTATION, { input: { offer_id: "x", fee_rate: 2971 } }],
    [magmaApi.TOGGLE_OFFER_MUTATION, { input: { offer_id: "x" } }],
    [magmaApi.SALES_QUERY, { input: { action_needed: true }, page: { limit: 50, offset: 0 } }],
    [magmaApi.SALES_QUERY, { input: { status: [...magmaApi.LEASE_RUNNING_STATUSES] }, page: { limit: 50, offset: 0 } }],
    [amboss.CANCEL_PURCHASE_MUTATION, { input: { order_id: "o-1", cancellation_reason: "UNABLE_TO_PAY" } }],
  ];
  for (const [doc, vars] of cases) assert.deepEqual(checkVariables(schema, doc, vars), [], doc.slice(0, 40));
});

test("every order status the code compares is a real MarketOrderStatus", () => {
  const enumValues = new Set(
    (schema.types.get("MarketOrderStatus")?.enumValues ?? []).map((e) => e.name),
  );
  assert.ok(enumValues.size >= 17, "the enum loaded");
  const used = [
    ...amboss.ORDER_FAILED,
    ...amboss.ORDER_SUCCEEDED,
    ...magmaApi.SELLER_ACTION_STATUSES,
    ...magmaApi.FUNDING_REPORTED_STATUSES,
    ...magmaApi.LEASE_RUNNING_STATUSES,
    "WAITING_FOR_SELLER_APPROVAL",
    "WAITING_FOR_BUYER_PAYMENT",
    "WAITING_FOR_CHANNEL_OPEN",
    "SELLER_SENT_TRANSACTION",
    "VALID_CHANNEL_OPENING",
    "CHANNEL_MONITORING_FINISHED",
    "INVALID_CHANNEL_OPENING",
  ];
  for (const s of used) assert.ok(enumValues.has(s), `${s} is not a MarketOrderStatus`);
  // Every failure state of the enum is treated as one (none falls through).
  for (const s of ["SELLER_REJECTED", "SELLER_FAILED_TO_REACT", "SELLER_FAILED_TO_OPEN_CHANNEL", "SELLER_FAILED_TO_SEND_SWAP", "BUYER_FAILED_TO_PAY", "BUYER_REJECTED", "INVALID_CHANNEL_OPENING", "ADMIN_CLOSED"]) {
    assert.ok(amboss.ORDER_FAILED.has(s), s);
  }
});

/** The documents sent to the legacy endpoint (public market data only). */
const SPACE_DOCUMENTS: Record<string, string> = {
  OFFER_BOOK_QUERY: amboss.OFFER_BOOK_QUERY,
  NODE_MARKET_QUERY: amboss.NODE_MARKET_QUERY,
};

for (const [name, doc] of Object.entries(SPACE_DOCUMENTS)) {
  test(`${name} matches the api.amboss.space schema (no deprecated field)`, () => {
    assert.deepEqual(checkDocument(ambossSpaceSchema(), doc), []);
  });
}

test("the public Magma queries fit their variables", () => {
  assert.deepEqual(checkVariables(schema, amboss.PUBLIC_OFFERS_QUERY, { page: { limit: 50, offset: 0 } }), []);
  assert.deepEqual(checkVariables(ambossSpaceSchema(), amboss.NODE_MARKET_QUERY, { pubkey: "02" + "11".repeat(32) }), []);
});

test("the offer book read from the legacy endpoint asks only for fields it still has", () => {
  // api.amboss.space: getOffers is not deprecated (checked with
  // includeDeprecated on its Query type); it carries the seller score.
  assert.match(amboss.OFFER_BOOK_QUERY, /getOffers/);
  assert.doesNotMatch(amboss.OFFER_BOOK_QUERY, /createOffer|updateOffer|toggleOffer|seller(Accept|AddTransaction|Reject)/);
});

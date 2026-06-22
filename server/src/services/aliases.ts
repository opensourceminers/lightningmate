import { getNode, type AuthenticatedLnd } from "lightning";

// Resolving a node alias hits the graph; cache results for the process lifetime.
const cache = new Map<string, string>();

/** Human-readable label for a peer: its alias, or a shortened pubkey fallback. */
export async function getAlias(
  lnd: AuthenticatedLnd,
  publicKey: string,
): Promise<string> {
  const hit = cache.get(publicKey);
  if (hit !== undefined) return hit;

  let alias = "";
  try {
    const node = await getNode({
      lnd,
      public_key: publicKey,
      is_omitting_channels: true,
    });
    alias = node.alias ?? "";
  } catch {
    // Node not found in our graph (e.g. private peer) — fall back to pubkey.
  }

  const label = alias.trim().length > 0 ? alias.trim() : `${publicKey.slice(0, 12)}…`;
  cache.set(publicKey, label);
  return label;
}

/**
 * Opening a node's details from anywhere a node is named, without passing a
 * callback through every panel (the same arrangement as nav.ts).
 *
 * Many views name a channel, not a node (a fee row, a forward, a history line
 * knows its channel id or only the alias): the channel list the app already
 * polls says whose it is.
 */
import { useEffect, useRef } from "react";
import type { OverrideMap } from "./types";

export interface NodeTarget {
  pubkey: string;
  /** Shown until the details have loaded. */
  alias?: string;
  /** An address someone typed (key@host:port), used when opening a channel. */
  socket?: string;
}

type Handler = (target: NodeTarget) => void;

let handler: Handler | null = null;

export function setNodeHandler(fn: Handler | null): void {
  handler = fn;
}

export function openNode(target: NodeTarget): void {
  handler?.(target);
}

/** What changed from the node details: the lists behind them read it once
 *  when they mount, and must not go on showing the old state. */
export interface NodeChange {
  /** A channel's fee mode was saved: every channel's, as the server now has them. */
  overrides?: OverrideMap;
  neverOpen?: { pubkey: string; never: boolean };
  /** A channel was opened or closed. */
  channels?: boolean;
}

const listeners = new Set<(change: NodeChange) => void>();

export function notifyNodeChanged(change: NodeChange): void {
  for (const listener of [...listeners]) listener(change);
}

export function useNodeChanges(on: (change: NodeChange) => void): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => {
    const listener = (change: NodeChange) => latest.current(change);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}

let byChannel = new Map<string, string>();
/** null: two peers share this alias, so it names neither. */
let byAlias = new Map<string, string | null>();

/** The channel list as last polled. */
export function rememberChannels(channels: readonly { id: string; peerPubkey: string; peerAlias: string }[]): void {
  byChannel = new Map(channels.map((c) => [c.id, c.peerPubkey]));
  const aliases = new Map<string, string | null>();
  for (const c of channels) {
    const seen = aliases.get(c.peerAlias);
    aliases.set(c.peerAlias, seen === undefined || seen === c.peerPubkey ? c.peerPubkey : null);
  }
  byAlias = aliases;
}

/** Whose node a view means: its key if it knows it, else by channel, else by
 *  alias. Undefined: nobody this node has a channel with (a closed one). */
export function resolveNode(ref: { pubkey?: string | null; channelId?: string | null; alias?: string | null }): string | undefined {
  if (ref.pubkey) return ref.pubkey;
  if (ref.channelId) {
    const pk = byChannel.get(ref.channelId);
    if (pk) return pk;
  }
  return ref.alias ? byAlias.get(ref.alias) ?? undefined : undefined;
}

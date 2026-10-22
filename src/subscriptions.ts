export type SubscriptionMode = "all" | "all_except" | "only";

export type Subscription = {
  session: string;
  mode: SubscriptionMode;
  chats: string[];
};

export function matches(subscription: Subscription, chat: string): boolean {
  if (subscription.mode === "all") return true;
  const listed = subscription.chats.includes(chat);
  return subscription.mode === "only" ? listed : !listed;
}

/** Chat IDs have an unbounded domain, so two broad filters always overlap. */
export function overlaps(a: Subscription, b: Subscription): boolean {
  if (a.mode === "only") return a.chats.some(chat => matches(b, chat));
  if (b.mode === "only") return b.chats.some(chat => matches(a, chat));
  return true;
}

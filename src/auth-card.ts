export type AuthCardStatus = 'authorized' | 'expired' | 'denied_or_failed' | 'replaced';

export function authResultCard(status: AuthCardStatus) {
  const authorized = status === 'authorized';
  return {
    schema: '2.0',
    header: {
      template: authorized ? 'green' : 'grey',
      title: { tag: 'plain_text', content: authorized ? 'Lark access authorized' : 'Lark authorization ended' },
    },
    body: { elements: [{ tag: 'markdown', content: authorized
      ? 'Authorization completed. You can now use the requested tools.'
      : 'This authorization link is no longer active. Start authorization again if access is still needed.' }] },
  };
}

export async function patchAuthResultCard(
  domain: string,
  messageId: string,
  tenantToken: string,
  status: AuthCardStatus,
  request: typeof fetch = fetch,
) {
  const response = await request(`${domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tenantToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: JSON.stringify(authResultCard(status)) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Lark card patch HTTP ${response.status}`);
  const result = await response.json() as { code?: number; msg?: string };
  if (result.code !== 0) throw new Error(`Lark card patch ${result.code}: ${result.msg}`);
}

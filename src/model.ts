// Model access. The model is chosen by CLAIMCHECK_MODEL; the key is AI_GATEWAY_API_KEY.
// With no key, callers hand the prompt to a person or an agent session instead.
export function modelAvailable(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY && process.env.CLAIMCHECK_MODEL);
}

/** https only, or http for a local gateway. Anything else is refused before the key is sent. */
export function gatewayUrl(raw: string | undefined): string {
  const base = raw ?? 'https://ai-gateway.vercel.sh/v1';
  let u: URL;
  try { u = new URL(base); } catch { throw new Error(`CLAIMCHECK_GATEWAY_URL is not a valid URL: ${JSON.stringify(base)}`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error(`CLAIMCHECK_GATEWAY_URL must use https (http is allowed only for localhost); refusing to send the key to ${u.protocol}//${u.host}`);
  }
  return base.replace(/\/+$/, '');
}

export async function askModel(prompt: string): Promise<string> {
  const base = gatewayUrl(process.env.CLAIMCHECK_GATEWAY_URL);
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}` },
    body: JSON.stringify({ model: process.env.CLAIMCHECK_MODEL, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  return json.choices[0].message.content;
}

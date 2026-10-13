// Model access. The model is chosen by CLAIMCHECK_MODEL; the key is AI_GATEWAY_API_KEY.
// With no key, callers hand the prompt to a person or an agent session instead.
export function modelAvailable(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY && process.env.CLAIMCHECK_MODEL);
}

export async function askModel(prompt: string): Promise<string> {
  const base = process.env.CLAIMCHECK_GATEWAY_URL ?? 'https://ai-gateway.vercel.sh/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}` },
    body: JSON.stringify({ model: process.env.CLAIMCHECK_MODEL, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  return json.choices[0].message.content;
}

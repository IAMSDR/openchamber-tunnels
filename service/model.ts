export type Provider = 'cloudflare-quick' | 'cloudflare-named' | 'microsoft';
export type Protocol = 'http' | 'https';

export interface Tunnel {
  id: string;
  name: string;
  provider: Provider;
  port: number;
  protocol: Protocol;
  public: boolean;
  keepRunning: boolean;
  hostname?: string;
  providerId?: string;
  url?: string;
  pid?: number;
  startedAt?: string;
  error?: string;
}

export const isPort = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535;

export function parseTunnel(value: unknown): Tunnel {
  if (!value || typeof value !== 'object') throw new Error('Invalid tunnel.');
  const t = value as Record<string, unknown>;
  if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 80 || /[\r\n]/.test(t.name)) throw new Error('Enter a name (up to 80 characters).');
  if (!['cloudflare-quick', 'cloudflare-named', 'microsoft'].includes(String(t.provider))) throw new Error('Choose a provider.');
  if (!isPort(t.port)) throw new Error('Enter a port between 1 and 65535.');
  if (t.protocol !== 'http' && t.protocol !== 'https') throw new Error('Choose HTTP or HTTPS for the local service.');
  if (typeof t.public !== 'boolean' || typeof t.keepRunning !== 'boolean') throw new Error('Invalid access or lifecycle setting.');
  if (t.provider === 'cloudflare-quick' && !t.public) throw new Error('Cloudflare Quick Tunnels require public access.');
  if (t.provider === 'cloudflare-named') {
    if (!t.public) throw new Error('Cloudflare DNS tunnels require public access. Configure Cloudflare Access separately to restrict access.');
    if (typeof t.hostname !== 'string' || !/^(?=.{4,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/i.test(t.hostname)) throw new Error('Enter a valid Cloudflare DNS hostname.');
  }
  if (t.provider === 'microsoft' && t.hostname) throw new Error('Hostnames are only for Cloudflare named tunnels.');
  return {
    id: typeof t.id === 'string' ? t.id : '', name: t.name.trim(), provider: t.provider as Provider,
    port: t.port, protocol: t.protocol, public: t.public, keepRunning: t.keepRunning,
    ...(t.provider === 'cloudflare-named' ? { hostname: String(t.hostname).toLowerCase() } : {}),
  };
}

export function commandFor(t: Tunnel): string[] {
  if (t.provider === 'cloudflare-quick') return ['cloudflared', 'tunnel', '--url', `${t.protocol}://127.0.0.1:${t.port}`];
  if (t.provider === 'cloudflare-named') return ['cloudflared', 'tunnel', '--url', `${t.protocol}://127.0.0.1:${t.port}`, 'run', t.providerId!];
  return ['devtunnel', 'host', t.providerId!, ...(t.public ? ['--allow-anonymous'] : [])];
}

export function redact(text: string): string {
  return text.replace(/\x1b\[[\d;]*m/g, '')
    .replace(/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):\d+/gi, '[local service]')
    .replace(/(token|secret|authorization|password)\s*[:=]\s*[^\s,]+/gi, '$1: [hidden]')
    .slice(-6000);
}

export function parseLoginPrompt(output: string): { url?: string; code?: string } {
  const clean = output.replace(/\x1b\[[\d;]*m/g, '');
  const urlMatch = clean.match(/https?:\/\/[^\s"'<>]+/i);
  const url = urlMatch?.[0].replace(/[.,;:!?)]+$/, '');
  const codeMatch =
    clean.match(/\benter\s+(?:the\s+)?code\s*[:\s]\s*([A-Z0-9-]{4,20})\b/i) ||
    clean.match(/\bcode\s*[:=]\s*([A-Z0-9-]{4,20})\b/i);
  const code = codeMatch?.[1]?.trim();
  return {
    ...(url ? { url } : {}),
    ...(code ? { code } : {}),
  };
}

import { describe, expect, test } from 'bun:test';
import { commandFor, parseLoginPrompt, parseTunnel, redact } from './model';

const base = { name: 'Web', provider: 'microsoft', port: 3000, protocol: 'http', public: false, keepRunning: false };

describe('tunnel validation and commands', () => {
  test('private Microsoft tunnel does not allow anonymous access', () => {
    const t = parseTunnel(base);
    t.providerId = 'abc';
    expect(commandFor(t)).toEqual(['devtunnel', 'host', 'abc']);
  });
  test('public Microsoft tunnel passes --allow-anonymous', () => {
    const t = parseTunnel({ ...base, public: true });
    t.providerId = 'abc';
    expect(commandFor(t)).toEqual(['devtunnel', 'host', 'abc', '--allow-anonymous']);
  });
  test('public exposure must be explicit for Cloudflare', () => {
    expect(() => parseTunnel({ ...base, provider: 'cloudflare-quick' })).toThrow('public');
    expect(() => parseTunnel({ ...base, provider: 'cloudflare-named', public: true })).toThrow('hostname');
  });
  test('does not accept invalid ports or protocols', () => {
    expect(() => parseTunnel({ ...base, port: 0 })).toThrow('port');
    expect(() => parseTunnel({ ...base, protocol: 'ssh' })).toThrow('HTTP');
  });
  test('redacts credentials in logs', () => {
    expect(redact('token: abc123 password=oops')).not.toContain('abc123');
    expect(redact('token: abc123 password=oops')).not.toContain('oops');
  });
  test('extracts device login URL and code for Microsoft and GitHub', () => {
    expect(
      parseLoginPrompt('To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code HV56RDX64 to authenticate.'),
    ).toEqual({ url: 'https://login.microsoft.com/device', code: 'HV56RDX64' });
    expect(
      parseLoginPrompt('Browse to https://github.com/login/device and enter the code: E6DA-F4A4\n'),
    ).toEqual({ url: 'https://github.com/login/device', code: 'E6DA-F4A4' });
    expect(
      parseLoginPrompt('Please open https://dash.cloudflare.com/argotunnel?callback=https%3A%2F%2F127.0.0.1%3A1234'),
    ).toEqual({ url: 'https://dash.cloudflare.com/argotunnel?callback=https%3A%2F%2F127.0.0.1%3A1234' });
  });
});

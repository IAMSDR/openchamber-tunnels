import { connectHost } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSelect,
  mountSeparator,
  mountSpinner,
  mountSwitch,
  mountTabs,
  mountText,
  mountTextField,
  type SelectOption,
} from '@openchamber/sdk/ui';
import { parseLoginPrompt } from '../service/model';

type Provider = 'cloudflare-quick' | 'cloudflare-named' | 'microsoft';
type LoginMethod = 'entra' | 'github';
type SetupOs = 'linux' | 'darwin' | 'win32';
type Tunnel = {
  id: string;
  name: string;
  provider: Provider;
  port: number;
  protocol: 'http' | 'https';
  public: boolean;
  keepRunning: boolean;
  hostname?: string;
  providerId?: string;
  pid?: number;
  url?: string;
  error?: string;
};
type ProviderStatus = {
  cloudflare: { cli: boolean; signedIn: boolean; account?: string };
  microsoft: { cli: boolean; signedIn: boolean; account?: string; provider?: string };
};
type LoginState = { output: string; finished: boolean; exitCode?: number; method?: LoginMethod };
type PendingOp =
  | { kind: 'start' | 'stop' | 'remove' | 'logs' | 'ports' | 'list-ports'; id: string }
  | { kind: 'login-ms'; method: LoginMethod }
  | { kind: 'cancel-login' | 'recheck'; provider: 'microsoft' | 'cloudflare' }
  | { kind: 'save' | 'logout-ms' | 'login-cf' | 'refresh' };

const PROVIDER_LABEL: Record<Provider, string> = {
  microsoft: 'Microsoft',
  'cloudflare-quick': 'CF Quick',
  'cloudflare-named': 'CF DNS',
};

const OS_LABEL: Record<SetupOs, string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
};

const CLI_GUIDES: Record<'microsoft' | 'cloudflare', {
  bin: string;
  docsUrl: string;
  releasesUrl?: string;
  steps: Record<SetupOs, { command?: string; note: string }>;
}> = {
  microsoft: {
    bin: 'devtunnel',
    docsUrl: 'https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started',
    steps: {
      linux: {
        command: 'curl -sL https://aka.ms/DevTunnelCliInstall | bash',
        note: 'Run on the OpenChamber server, then ensure devtunnel is on PATH (restart OpenChamber if PATH changed).',
      },
      darwin: {
        command: 'brew install --cask devtunnel',
        note: 'Install with Homebrew on the OpenChamber server macOS machine.',
      },
      win32: {
        command: 'winget install Microsoft.devtunnel',
        note: 'Install with winget on the OpenChamber server Windows machine, then restart OpenChamber if needed.',
      },
    },
  },
  cloudflare: {
    bin: 'cloudflared',
    docsUrl: 'https://developers.cloudflare.com/tunnel/downloads/',
    releasesUrl: 'https://github.com/cloudflare/cloudflared/releases/latest',
    steps: {
      linux: {
        note: 'Install via Cloudflare’s apt/rpm package repository or download the Linux binary onto the OpenChamber server.',
      },
      darwin: {
        command: 'brew install cloudflared',
        note: 'Install with Homebrew on the OpenChamber server macOS machine.',
      },
      win32: {
        note: 'Download the Windows installer or cloudflared.exe onto the OpenChamber server and add it to PATH.',
      },
    },
  },
};

const ALL_PROVIDER_OPTIONS: Array<{ id: Provider; label: string; hint?: string }> = [
  { id: 'microsoft', label: 'Microsoft Dev Tunnels', hint: 'Private by default' },
  { id: 'cloudflare-quick', label: 'Cloudflare Quick (public)', hint: 'Temporary URL' },
  { id: 'cloudflare-named', label: 'Cloudflare named (public DNS)', hint: 'Custom domain' },
];

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;

const form = {
  name: '',
  provider: 'cloudflare-quick' as Provider,
  port: '3000',
  protocol: 'http' as 'http' | 'https',
  public: true,
  publicConfirmed: false,
  keepRunning: false,
  hostname: '',
};

let tunnels: Tunnel[] = [];
let providers: ProviderStatus = {
  cloudflare: { cli: false, signedIn: false },
  microsoft: { cli: false, signedIn: false },
};
let serverPlatform: SetupOs = 'linux';
const setupOsByProvider: Record<'microsoft' | 'cloudflare', SetupOs | null> = {
  microsoft: null,
  cloudflare: null,
};
let tab: 'tunnels' | 'accounts' = 'tunnels';
let view: 'list' | 'form' = 'list';
let editing: string | null = null;
let portsOpen: Record<string, boolean> = {};
let confirmAction: { id: string; kind: 'start-public' | 'remove' } | null = null;
let msSwitchOpen = false;
let logsById: Record<string, string> = {};
let extraPortInput: Record<string, string> = {};
let error = '';
let notice = '';
let busy = false;
let pending: PendingOp | null = null;
let ready = false;
let loginOutput: Record<string, LoginState> = {};
let loginTimer: ReturnType<typeof setTimeout> | undefined;
let urlTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let urlPolls = 0;

function el(parent: HTMLElement, className = '', tag: keyof HTMLElementTagNameMap = 'div') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function text(parent: HTMLElement, content: string, className = '', tag: keyof HTMLElementTagNameMap = 'div') {
  const node = el(parent, className, tag);
  node.textContent = content;
  return node;
}

function isPending(kind: PendingOp['kind'], id?: string): boolean {
  if (!pending || pending.kind !== kind) return false;
  if (id === undefined) return true;
  return 'id' in pending && pending.id === id;
}

function clearNotice() {
  clearTimeout(noticeTimer);
  notice = '';
}

function showToast(message: string, kind: 'success' | 'info' = 'success') {
  clearNotice();
  void host.toast({ kind, message }).catch(() => {
    notice = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = '';
      render();
    }, 3500);
    render();
  });
}

function btn(
  parent: HTMLElement,
  label: string,
  onClick: () => void,
  variant: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' = 'outline',
  size: 'default' | 'sm' | 'xs' = 'sm',
  disabled = false,
  loading = false,
  ignoreBusy = false,
) {
  return mountButton(el(parent), {
    label,
    onClick,
    variant,
    size,
    disabled: (!ignoreBusy && busy && !loading) || disabled,
    loading,
  });
}

function trashButton(
  parent: HTMLElement,
  label: string,
  onClick: () => void,
  disabled = false,
  loading = false,
) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'icon-btn';
  node.title = label;
  node.setAttribute('aria-label', label);
  node.disabled = (busy && !loading) || disabled || loading;

  if (loading) {
    mountSpinner(node, { size: 'sm' });
  } else {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6']) {
      const path = document.createElementNS(svgNs, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    node.append(svg);
  }
  node.addEventListener('click', onClick);
  parent.append(node);
  return node;
}

type ProviderOption = SelectOption & { id: Provider; disabled?: boolean };

function providerOptions(): ProviderOption[] {
  return [
    {
      id: 'microsoft',
      label: 'Microsoft Dev Tunnels',
      hint: !providers.microsoft.cli
        ? 'CLI missing'
        : !providers.microsoft.signedIn
          ? 'Sign in required'
          : providers.microsoft.account || 'Signed in',
      disabled: !(providers.microsoft.cli && providers.microsoft.signedIn),
    },
    {
      id: 'cloudflare-quick',
      label: 'Cloudflare Quick (public)',
      hint: !providers.cloudflare.cli ? 'CLI missing' : 'Temporary URL',
      disabled: !providers.cloudflare.cli,
    },
    {
      id: 'cloudflare-named',
      label: 'Cloudflare named (public DNS)',
      hint: !providers.cloudflare.cli
        ? 'CLI missing'
        : !providers.cloudflare.signedIn
          ? 'Sign in required'
          : 'Custom domain',
      disabled: !(providers.cloudflare.cli && providers.cloudflare.signedIn),
    },
  ];
}

function resetForm(preset?: Tunnel) {
  if (preset) {
    form.name = preset.name;
    form.provider = preset.provider;
    form.port = String(preset.port);
    form.protocol = preset.protocol;
    form.public = preset.public;
    form.publicConfirmed = preset.provider !== 'microsoft';
    form.keepRunning = preset.keepRunning;
    form.hostname = preset.hostname || '';
    editing = preset.id;
  } else {
    const first = providerOptions().find((o) => !o.disabled)?.id ?? 'cloudflare-quick';
    form.name = '';
    form.provider = first;
    form.port = '3000';
    form.protocol = 'http';
    form.public = first !== 'microsoft';
    form.publicConfirmed = false;
    form.keepRunning = false;
    form.hostname = '';
    editing = null;
  }
}

function openCreate() {
  error = '';
  clearNotice();
  resetForm();
  tab = 'tunnels';
  view = 'form';
  render();
}

function openEdit(t: Tunnel) {
  error = '';
  clearNotice();
  resetForm(t);
  tab = 'tunnels';
  view = 'form';
  render();
}

async function request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: object) {
  const result = await host.serviceRequest({ method, path, ...(body ? { body: JSON.stringify(body) } : {}) });
  let data: any;
  try {
    data = result.body ? JSON.parse(result.body) : {};
  } catch {
    throw new Error(`The tunnel service returned invalid JSON for ${path}.`);
  }
  if (result.status >= 400 || data?.error) throw new Error(data?.error || `Request failed (${result.status}).`);
  return data;
}

function normalizeProviders(data: any): ProviderStatus {
  if (data?.providers?.cloudflare && data?.providers?.microsoft) {
    return data.providers as ProviderStatus;
  }
  if (data?.cli && typeof data.cli.cloudflare === 'boolean' && typeof data.cli.microsoft === 'boolean') {
    return {
      cloudflare: { cli: data.cli.cloudflare, signedIn: false },
      microsoft: { cli: data.cli.microsoft, signedIn: false },
    };
  }
  throw new Error('Tunnel service returned an incomplete status. Refresh or restart the extension.');
}

function scheduleUrlWatch() {
  clearTimeout(urlTimer);
  const waitingForUrl = tunnels.some((t) => Boolean(t.pid) && !t.url && t.provider !== 'cloudflare-named');
  if (!waitingForUrl || urlPolls >= 8) return;
  urlTimer = setTimeout(() => {
    urlPolls += 1;
    void refresh({ quiet: true });
  }, 1500);
}

function normalizePlatform(value: unknown): SetupOs {
  if (value === 'darwin' || value === 'win32' || value === 'linux') return value;
  return serverPlatform;
}

async function refresh(options?: { quiet?: boolean; manual?: boolean }) {
  if (options?.manual) {
    busy = true;
    pending = { kind: 'refresh' };
    render();
  }
  try {
    const data = await request('GET', '/tunnels');
    if (!Array.isArray(data.tunnels)) throw new Error('Tunnel service returned an incomplete list.');
    const nextProviders = normalizeProviders(data);
    const nextPlatform = normalizePlatform(data.platform);
    const prevSnapshot = JSON.stringify({ tunnels, providers, serverPlatform });
    tunnels = data.tunnels;
    providers = nextProviders;
    serverPlatform = nextPlatform;
    if (!options?.quiet) error = '';
    if (!options?.quiet || prevSnapshot !== JSON.stringify({ tunnels, providers, serverPlatform })) {
      render();
    }
    scheduleUrlWatch();
  } catch (e) {
    if (!options?.quiet) {
      error = (e as Error).message;
      render();
    }
  } finally {
    if (options?.manual) {
      busy = false;
      pending = null;
      render();
    }
  }
}

async function recheckCli(provider: 'microsoft' | 'cloudflare') {
  busy = true;
  pending = { kind: 'recheck', provider };
  error = '';
  clearNotice();
  render();
  try {
    await refresh();
    const found = providers[provider].cli;
    const bin = CLI_GUIDES[provider].bin;
    if (found) {
      showToast(`${bin} detected on PATH.`);
    } else {
      showToast(`${bin} still not found on PATH. Restart OpenChamber if you updated PATH.`, 'info');
    }
  } catch (e) {
    error = (e as Error).message;
  } finally {
    busy = false;
    pending = null;
    render();
  }
}

async function act(
  op: PendingOp,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: object,
  success: string,
  onDone?: () => void,
  options?: { skipRefresh?: boolean },
) {
  busy = true;
  pending = op;
  error = '';
  clearNotice();
  if (op.kind !== 'remove' && op.kind !== 'start') {
    confirmAction = null;
  }
  render();
  try {
    await request(method, path, body);
    confirmAction = null;
    if (path === '/start') urlPolls = 0;
    onDone?.();
    if (!options?.skipRefresh) {
      await refresh();
    }
    if (success) showToast(success);
  } catch (e) {
    confirmAction = null;
    error = (e as Error).message;
    if (!options?.skipRefresh) {
      await refresh({ quiet: true });
    }
  } finally {
    busy = false;
    pending = null;
    render();
  }
}

async function copyText(value: string, label: string) {
  try {
    await host.writeClipboard(value);
    showToast(`${label} copied`);
  } catch {
    showToast(`${label}: ${value}`, 'info');
  }
}

async function loadLogs(id: string) {
  busy = true;
  pending = { kind: 'logs', id };
  error = '';
  clearNotice();
  render();
  try {
    const data = await request('GET', `/logs?id=${encodeURIComponent(id)}`);
    logsById[id] = data.output || data.lastError || 'No logs recorded yet.';
  } catch (e) {
    error = (e as Error).message;
  } finally {
    busy = false;
    pending = null;
    render();
  }
}

async function loadPorts(id: string) {
  busy = true;
  pending = { kind: 'list-ports', id };
  error = '';
  clearNotice();
  render();
  try {
    const data = await request('GET', `/ports?id=${encodeURIComponent(id)}`);
    logsById[id] = JSON.stringify(data.ports, null, 2);
  } catch (e) {
    error = (e as Error).message;
  } finally {
    busy = false;
    pending = null;
    render();
  }
}

async function refreshLogin() {
  const prevPending = Object.entries(loginOutput)
    .filter(([, item]) => !item.finished)
    .map(([k]) => k);
  try {
    const data = await request('GET', '/login');
    loginOutput = data.login || {};
    const newlyFinished = prevPending.filter((k) => loginOutput[k]?.finished);
    if (newlyFinished.length) {
      await refresh({ quiet: true });
      for (const k of newlyFinished) {
        if (loginOutput[k]?.exitCode === 0) {
          showToast(k === 'cloudflare' ? 'Signed in to Cloudflare.' : 'Signed in to Microsoft Dev Tunnels.');
        }
      }
    }
    if (tab === 'accounts' && view === 'list') render();
  } catch {
    /* sign-in polling can recover on the next manual refresh */
  }
  clearTimeout(loginTimer);
  const pendingItems = Object.values(loginOutput).filter((item) => !item.finished);
  if (pendingItems.length) {
    const waitingPrompt = pendingItems.some((item) => !item.output);
    loginTimer = setTimeout(() => void refreshLogin(), waitingPrompt ? 500 : 1800);
  }
}

function renderTopbar(target: HTMLElement) {
  const bar = el(target, 'topbar');
  const tabsWrap = el(bar);
  mountTabs(tabsWrap, {
    trackBackground: true,
    activeId: tab,
    items: [
      { id: 'tunnels', label: 'Tunnels', count: tunnels.length },
      { id: 'accounts', label: 'Accounts' },
    ],
    onChange: (next) => {
      tab = next as 'tunnels' | 'accounts';
      view = 'list';
      msSwitchOpen = false;
      error = '';
      clearNotice();
      render();
    },
  });
  const right = el(bar, 'topbar-actions');
  const refreshing = isPending('refresh');
  btn(
    right,
    refreshing ? 'Refreshing…' : 'Refresh',
    () => {
      void refresh({ manual: true });
      void refreshLogin();
    },
    'ghost',
    'sm',
    false,
    refreshing,
  );
  if (view !== 'form' && (tunnels.length > 0 || tab === 'accounts')) {
    btn(right, 'New tunnel', openCreate, 'default', 'sm');
  }
}

function renderStatusStrip(target: HTMLElement) {
  const strip = el(target, 'status-strip');

  const msPill = el(strip, 'account-pill', 'button') as HTMLButtonElement;
  msPill.type = 'button';
  msPill.title = !providers.microsoft.cli
    ? 'devtunnel CLI missing — click for install guide'
    : 'Open provider accounts';
  const msDot = el(msPill, 'dot', 'span');
  msDot.dataset.tone = !providers.microsoft.cli ? 'error' : providers.microsoft.signedIn ? 'success' : 'muted';
  text(msPill, 'Microsoft', 'account-pill-label', 'span');
  text(
    msPill,
    !providers.microsoft.cli
      ? 'CLI missing'
      : providers.microsoft.signedIn
        ? providers.microsoft.account || 'Signed in'
        : 'Not signed in',
    'account-pill-value',
    'span',
  );
  msPill.addEventListener('click', () => {
    tab = 'accounts';
    render();
  });

  const cfPill = el(strip, 'account-pill', 'button') as HTMLButtonElement;
  cfPill.type = 'button';
  cfPill.title = !providers.cloudflare.cli
    ? 'cloudflared CLI missing — click for install guide'
    : 'Open provider accounts';
  const cfDot = el(cfPill, 'dot', 'span');
  cfDot.dataset.tone = !providers.cloudflare.cli ? 'error' : providers.cloudflare.signedIn ? 'success' : 'info';
  text(cfPill, 'Cloudflare', 'account-pill-label', 'span');
  text(
    cfPill,
    !providers.cloudflare.cli
      ? 'CLI missing'
      : providers.cloudflare.signedIn
        ? 'Signed in'
        : 'Quick ready',
    'account-pill-value',
    'span',
  );
  cfPill.addEventListener('click', () => {
    tab = 'accounts';
    render();
  });
}

function renderTunnelCard(target: HTMLElement, t: Tunnel) {
  const logsVisible = logsById[t.id] !== undefined;
  const portsVisible = Boolean(portsOpen[t.id]);
  const starting = isPending('start', t.id);
  const stopping = isPending('stop', t.id);
  const removing = isPending('remove', t.id);
  const loadingLogs = isPending('logs', t.id);
  const loadingPorts = isPending('ports', t.id) || isPending('list-ports', t.id);
  const resolvingUrl = Boolean(t.pid) && !t.url && t.provider !== 'cloudflare-named' && urlPolls < 8;
  const cliProvider = t.provider === 'microsoft' ? 'microsoft' : 'cloudflare';
  const missingCli = !providers[cliProvider].cli;

  const card = el(target, logsVisible || portsVisible ? 'card is-selected' : 'card');

  const head = el(card, 'tunnel-head');
  const info = el(head, 'tunnel-info');
  const titleRow = el(info, 'tunnel-title-row');
  text(titleRow, t.name, 'tunnel-name', 'span');
  text(titleRow, `:${t.port}`, 'port-chip', 'span');
  mountBadge(el(titleRow), {
    label: removing
      ? 'Removing'
      : starting
        ? 'Starting'
        : stopping
          ? 'Stopping'
          : t.pid
            ? 'Running'
            : t.error
              ? 'Error'
              : 'Stopped',
    tone: removing || starting || stopping ? 'info' : t.pid ? 'success' : t.error ? 'error' : 'neutral',
  });

  const meta = el(info, 'tunnel-meta');
  text(meta, `${t.protocol.toUpperCase()} · ${PROVIDER_LABEL[t.provider]}`, '', 'span');
  text(meta, '·', '', 'span');
  text(meta, t.public ? 'Public' : 'Private', t.public ? 'meta-warn' : '', 'span');
  if (t.keepRunning) {
    text(meta, '· Keep running', '', 'span');
  }
  if (t.hostname) {
    text(meta, `· ${t.hostname}`, '', 'span');
  }

  const cta = el(head, 'actions');
  btn(
    cta,
    starting ? 'Starting…' : stopping ? 'Stopping…' : t.pid ? 'Stop' : 'Start',
    () => {
      if (!t.pid && t.public) {
        confirmAction = { id: t.id, kind: 'start-public' };
        render();
        return;
      }
      void act(
        { kind: t.pid ? 'stop' : 'start', id: t.id },
        'POST',
        t.pid ? '/stop' : '/start',
        { id: t.id },
        t.pid ? 'Tunnel stopped.' : 'Tunnel started.',
      );
    },
    t.pid ? 'outline' : 'default',
    'xs',
    removing || (!t.pid && missingCli),
    starting || stopping,
  );
  trashButton(
    cta,
    `Remove ${t.name} locally`,
    () => {
      confirmAction = confirmAction?.id === t.id && confirmAction.kind === 'remove'
        ? null
        : { id: t.id, kind: 'remove' };
      render();
    },
    starting || stopping,
    removing,
  );

  if (confirmAction?.id === t.id && confirmAction.kind === 'start-public') {
    const strip = el(card, 'confirm-strip');
    text(strip, `Public exposure: anyone with the URL can reach port ${t.port}.`, 'confirm-text');
    const cActions = el(strip, 'actions');
    btn(
      cActions,
      starting ? 'Starting…' : 'Start publicly',
      () => void act({ kind: 'start', id: t.id }, 'POST', '/start', { id: t.id }, 'Public tunnel started.'),
      'default',
      'xs',
      false,
      starting,
    );
    btn(cActions, 'Cancel', () => { confirmAction = null; render(); }, 'ghost', 'xs', starting);
  }

  if (confirmAction?.id === t.id && confirmAction.kind === 'remove') {
    const strip = el(card, 'confirm-strip');
    strip.dataset.tone = 'error';
    text(strip, `Remove "${t.name}" locally? Provider-side resources remain.`, 'confirm-text');
    const cActions = el(strip, 'actions');
    btn(
      cActions,
      removing ? 'Removing…' : 'Remove',
      () =>
        void act({ kind: 'remove', id: t.id }, 'DELETE', '/tunnels', { id: t.id }, 'Local entry removed.', () => {
          delete logsById[t.id];
          delete portsOpen[t.id];
        }),
      'destructive',
      'xs',
      false,
      removing,
    );
    btn(cActions, 'Cancel', () => { confirmAction = null; render(); }, 'ghost', 'xs', removing);
  }

  if (t.url) {
    const urlRow = el(card, 'url-row');
    const link = el(urlRow, 'url-link', 'button') as HTMLButtonElement;
    link.type = 'button';
    link.textContent = t.url;
    link.addEventListener('click', () => void host.openUrl(t.url!));
    btn(urlRow, 'Copy', () => void copyText(t.url!, 'Tunnel URL'), 'ghost', 'xs', false, false, true);
  } else if (resolvingUrl) {
    mountSpinner(el(card), { size: 'sm', label: 'Waiting for tunnel URL…' });
  }

  if (t.error && !t.pid) {
    text(card, t.error, 'error-note');
  } else if (!t.pid && missingCli) {
    const warn = el(card, 'cli-warning');
    const guide = CLI_GUIDES[cliProvider];
    text(warn, `${guide.bin} was not found on PATH.`, 'confirm-text');
    const wActions = el(warn, 'actions');
    btn(wActions, 'Install docs ↗', () => void host.openUrl(guide.docsUrl), 'ghost', 'xs', false, false, true);
    btn(wActions, 'Setup', () => { tab = 'accounts'; render(); }, 'outline', 'xs');
  }

  const foot = el(card, 'tunnel-foot');
  const leftFoot = el(foot, 'actions');
  btn(
    leftFoot,
    loadingLogs ? 'Loading…' : logsVisible ? 'Hide logs' : 'Logs',
    () => {
      if (logsVisible) {
        delete logsById[t.id];
        render();
      } else {
        void loadLogs(t.id);
      }
    },
    'ghost',
    'xs',
    false,
    loadingLogs,
  );
  if (t.provider === 'microsoft' && t.providerId) {
    btn(
      leftFoot,
      portsVisible ? 'Hide ports' : 'Ports',
      () => {
        portsOpen[t.id] = !portsVisible;
        render();
      },
      'ghost',
      'xs',
    );
  }
  btn(leftFoot, 'Edit', () => openEdit(t), 'ghost', 'xs', Boolean(t.pid) || removing);

  if (logsVisible || (portsVisible && t.provider === 'microsoft' && t.providerId)) {
    const details = el(card, 'tunnel-details');

    if (logsVisible) {
      const pre = el(details, 'log-box', 'pre');
      pre.textContent = logsById[t.id] ?? '';
    }

    if (portsVisible && t.provider === 'microsoft' && t.providerId) {
      mountSeparator(details, { label: 'Additional ports' });
      if (t.pid) {
        text(details, 'Stop the tunnel before adding or removing provider ports.', 'muted');
      }
      mountTextField(el(details), {
        label: 'Port',
        value: extraPortInput[t.id] ?? '',
        placeholder: 'e.g. 5173',
        onChange: (v) => { extraPortInput[t.id] = v; },
        helper: 'Manage extra forwarded ports on this Dev Tunnel.',
      });
      const portActions = el(details, 'actions');
      for (const action of ['add', 'remove'] as const) {
        btn(
          portActions,
          action === 'add' ? 'Add port' : 'Remove port',
          () => {
            const portNum = Number(extraPortInput[t.id]);
            if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
              error = 'Enter a port between 1 and 65535.';
              render();
              return;
            }
            void act(
              { kind: 'ports', id: t.id },
              'POST',
              '/ports',
              { id: t.id, port: portNum, action, protocol: t.protocol },
              `Port ${portNum} ${action === 'add' ? 'added' : 'removed'}.`,
            );
          },
          'outline',
          'xs',
          Boolean(t.pid),
          isPending('ports', t.id),
        );
      }
      btn(
        portActions,
        isPending('list-ports', t.id) ? 'Listing…' : 'List ports',
        () => void loadPorts(t.id),
        'ghost',
        'xs',
        false,
        loadingPorts,
      );
    }
  }
}

function renderTunnelsTab(target: HTMLElement) {
  renderStatusStrip(target);

  if (!tunnels.length) {
    const hasReadyProvider = providerOptions().some((o) => !o.disabled);
    if (!providers.microsoft.cli && !providers.cloudflare.cli) {
      mountEmpty(el(target), {
        title: 'Install a tunnel CLI to get started',
        body: 'Tunnels uses cloudflared or devtunnel on the OpenChamber server. Open Accounts for install commands and docs.',
        action: { label: 'Setup & accounts', onClick: () => { tab = 'accounts'; render(); } },
      });
    } else if (!hasReadyProvider) {
      mountEmpty(el(target), {
        title: 'Sign in to create a tunnel',
        body: 'Microsoft Dev Tunnels CLI is installed. Sign in under Accounts to expose your first local port.',
        action: { label: 'Open Accounts', onClick: () => { tab = 'accounts'; render(); } },
      });
    } else {
      mountEmpty(el(target), {
        title: 'No tunnels yet',
        body: 'Expose a local port through Microsoft Dev Tunnels or Cloudflare.',
        action: { label: 'New tunnel', onClick: openCreate },
      });
    }
    return;
  }

  const list = el(target, 'stack');
  for (const t of tunnels) {
    renderTunnelCard(list, t);
  }
}

function renderLoginBox(card: HTMLElement, provider: 'microsoft' | 'cloudflare', state: LoginState) {
  const box = el(card, 'login-output');
  const head = el(box, 'login-head');
  const cancelling = pending?.kind === 'cancel-login' && pending.provider === provider;

  if (!state.finished) {
    const label =
      provider === 'cloudflare'
        ? 'Waiting for browser authorization…'
        : state.method === 'github'
          ? 'Waiting for GitHub approval…'
          : 'Waiting for Microsoft approval…';
    mountSpinner(el(head), { size: 'sm', label });
  } else {
    text(head, state.exitCode === 0 ? 'Login finished' : 'Login did not complete', 'muted');
  }

  btn(
    head,
    cancelling ? 'Cancelling…' : state.finished ? 'Dismiss' : 'Cancel',
    () => {
      void act(
        { kind: 'cancel-login', provider },
        'POST',
        '/login/cancel',
        { provider },
        state.finished ? '' : 'Login cancelled.',
        () => {
          delete loginOutput[provider];
          void refreshLogin();
        },
        { skipRefresh: true },
      );
    },
    'ghost',
    'xs',
    false,
    cancelling,
    true,
  );

  const parsed = parseLoginPrompt(state.output || '');
  if (parsed.url) {
    const field = el(box, 'login-field');
    text(field, 'Verification URL', 'login-field-label');
    const urlRow = el(field, 'url-row');
    const link = el(urlRow, 'url-link', 'button') as HTMLButtonElement;
    link.type = 'button';
    link.textContent = parsed.url;
    link.addEventListener('click', () => void host.openUrl(parsed.url!));
    const urlActions = el(urlRow, 'actions');
    btn(urlActions, 'Copy', () => void copyText(parsed.url!, 'Login URL'), 'ghost', 'xs', false, false, true);
    btn(urlActions, 'Open', () => void host.openUrl(parsed.url!), 'outline', 'xs', false, false, true);
  }

  if (parsed.code) {
    const field = el(box, 'login-field');
    text(field, 'Device code', 'login-field-label');
    const codeRow = el(field, 'code-row');
    text(codeRow, parsed.code, 'code-value', 'span');
    btn(codeRow, 'Copy', () => void copyText(parsed.code!, 'Device code'), 'outline', 'xs', false, false, true);
  }

  if ((!parsed.url || (state.finished && state.exitCode !== 0)) && state.output) {
    mountText(el(box), { text: state.output, onOpenUrl: (url: string) => void host.openUrl(url) });
  }
}

function startMicrosoftLogin(method: LoginMethod) {
  msSwitchOpen = false;
  void act(
    { kind: 'login-ms', method },
    'POST',
    '/login',
    { provider: 'microsoft', method },
    `${method === 'github' ? 'GitHub' : 'Microsoft'} device-code login started.`,
    () => {
      void refreshLogin();
    },
    { skipRefresh: true },
  );
}

function renderSetupBox(card: HTMLElement, provider: 'microsoft' | 'cloudflare') {
  const guide = CLI_GUIDES[provider];
  const os = setupOsByProvider[provider] ?? serverPlatform;
  const step = guide.steps[os];
  const rechecking = pending?.kind === 'recheck' && pending.provider === provider;

  const box = el(card, 'setup-box');
  const head = el(box, 'setup-head');
  text(head, `Install ${guide.bin}`, 'setup-title', 'span');

  const osSwitch = el(head, 'os-switch');
  for (const key of ['linux', 'darwin', 'win32'] as const) {
    const osBtn = el(osSwitch, 'os-btn', 'button') as HTMLButtonElement;
    osBtn.type = 'button';
    osBtn.textContent = key === serverPlatform ? `${OS_LABEL[key]} (server)` : OS_LABEL[key];
    osBtn.setAttribute('aria-pressed', String(os === key));
    osBtn.addEventListener('click', () => {
      setupOsByProvider[provider] = key;
      render();
    });
  }

  if (step.command) {
    const cmdRow = el(box, 'cmd-row');
    text(cmdRow, step.command, 'cmd-text', 'code');
    btn(cmdRow, 'Copy', () => void copyText(step.command!, `${guide.bin} install command`), 'outline', 'xs', false, false, true);
  }

  text(box, step.note, 'setup-note');

  const actions = el(box, 'actions');
  btn(actions, 'Install docs ↗', () => void host.openUrl(guide.docsUrl), 'outline', 'xs', false, false, true);
  if (guide.releasesUrl) {
    btn(actions, 'Releases ↗', () => void host.openUrl(guide.releasesUrl!), 'ghost', 'xs', false, false, true);
  }
  btn(
    actions,
    rechecking ? 'Checking…' : 'Re-check CLI',
    () => void recheckCli(provider),
    'default',
    'xs',
    false,
    rechecking,
  );
}

function renderAccountsTab(target: HTMLElement) {
  const stack = el(target, 'stack');

  const msCard = el(stack, 'card');
  const msHead = el(msCard, 'account-head');
  text(msHead, 'Microsoft Dev Tunnels', 'account-title');
  mountBadge(el(msHead), {
    label: !providers.microsoft.cli
      ? 'CLI missing'
      : providers.microsoft.signedIn
        ? 'Signed in'
        : 'Not signed in',
    tone: !providers.microsoft.cli ? 'error' : providers.microsoft.signedIn ? 'success' : 'neutral',
  });
  text(
    msCard,
    !providers.microsoft.cli
      ? 'devtunnel was not found on PATH on the OpenChamber server.'
      : providers.microsoft.signedIn
        ? `Authenticated as ${providers.microsoft.account || 'user'}${providers.microsoft.provider ? ` (${providers.microsoft.provider})` : ''}.`
        : 'Choose Microsoft or GitHub device-code sign-in to host Dev Tunnels.',
    'account-meta',
  );

  const msLogin = loginOutput.microsoft;
  const msPendingLogin = Boolean(msLogin && !msLogin.finished);
  const loggingInEntra = pending?.kind === 'login-ms' && pending.method === 'entra';
  const loggingInGithub = pending?.kind === 'login-ms' && pending.method === 'github';
  const loggingOutMs = isPending('logout-ms');

  if (!providers.microsoft.cli) {
    renderSetupBox(msCard, 'microsoft');
  } else if (!msPendingLogin) {
    const msActions = el(msCard, 'actions');
    if (!providers.microsoft.signedIn) {
      btn(
        msActions,
        loggingInEntra ? 'Starting…' : 'Sign in with Microsoft',
        () => startMicrosoftLogin('entra'),
        'default',
        'sm',
        false,
        loggingInEntra,
      );
      btn(
        msActions,
        loggingInGithub ? 'Starting…' : 'Sign in with GitHub',
        () => startMicrosoftLogin('github'),
        'outline',
        'sm',
        false,
        loggingInGithub,
      );
    } else {
      btn(
        msActions,
        'Switch account',
        () => {
          msSwitchOpen = !msSwitchOpen;
          render();
        },
        'outline',
        'sm',
      );
      btn(
        msActions,
        loggingOutMs ? 'Signing out…' : 'Sign out',
        () => {
          msSwitchOpen = false;
          void act({ kind: 'logout-ms' }, 'POST', '/logout', { provider: 'microsoft' }, 'Signed out of Microsoft Dev Tunnels.');
        },
        'ghost',
        'sm',
        false,
        loggingOutMs,
      );
    }
    btn(msActions, 'Docs ↗', () => void host.openUrl(CLI_GUIDES.microsoft.docsUrl), 'ghost', 'sm', false, false, true);
  }

  if (providers.microsoft.cli && providers.microsoft.signedIn && msSwitchOpen && !msPendingLogin) {
    const strip = el(msCard, 'confirm-strip');
    text(strip, 'Choose which account type to sign in with:', 'confirm-text');
    const cActions = el(strip, 'actions');
    btn(
      cActions,
      loggingInEntra ? 'Starting…' : 'Microsoft',
      () => startMicrosoftLogin('entra'),
      'default',
      'xs',
      false,
      loggingInEntra,
    );
    btn(
      cActions,
      loggingInGithub ? 'Starting…' : 'GitHub',
      () => startMicrosoftLogin('github'),
      'outline',
      'xs',
      false,
      loggingInGithub,
    );
    btn(cActions, 'Cancel', () => { msSwitchOpen = false; render(); }, 'ghost', 'xs');
  }

  if (msLogin && (!msLogin.finished || (msLogin.exitCode !== undefined && msLogin.exitCode !== 0 && msLogin.output))) {
    renderLoginBox(msCard, 'microsoft', msLogin);
  }

  const cfCard = el(stack, 'card');
  const cfHead = el(cfCard, 'account-head');
  text(cfHead, 'Cloudflare', 'account-title');
  mountBadge(el(cfHead), {
    label: !providers.cloudflare.cli
      ? 'CLI missing'
      : providers.cloudflare.signedIn
        ? 'Signed in'
        : 'Quick ready',
    tone: !providers.cloudflare.cli ? 'error' : providers.cloudflare.signedIn ? 'success' : 'info',
  });
  text(
    cfCard,
    !providers.cloudflare.cli
      ? 'cloudflared was not found on PATH on the OpenChamber server.'
      : providers.cloudflare.signedIn
        ? 'Origin certificate detected. Both Quick temporary URLs and named DNS tunnels are available.'
        : 'Quick tunnels need no account. Sign in to generate an origin certificate for named DNS tunnels.',
    'account-meta',
  );

  const cfLogin = loginOutput.cloudflare;
  const cfPendingLogin = Boolean(cfLogin && !cfLogin.finished);
  const loggingInCf = isPending('login-cf');
  if (!providers.cloudflare.cli) {
    renderSetupBox(cfCard, 'cloudflare');
  } else if (!cfPendingLogin) {
    const cfActions = el(cfCard, 'actions');
    btn(
      cfActions,
      loggingInCf ? 'Starting…' : providers.cloudflare.signedIn ? 'Re-authenticate' : 'Sign in to Cloudflare',
      () => {
        void act(
          { kind: 'login-cf' },
          'POST',
          '/login',
          { provider: 'cloudflare' },
          'Cloudflare login started.',
          () => { void refreshLogin(); },
          { skipRefresh: true },
        );
      },
      providers.cloudflare.signedIn ? 'outline' : 'default',
      'sm',
      false,
      loggingInCf,
    );
    btn(cfActions, 'Docs ↗', () => void host.openUrl(CLI_GUIDES.cloudflare.docsUrl), 'ghost', 'sm', false, false, true);
  }
  if (cfLogin && (!cfLogin.finished || (cfLogin.exitCode !== undefined && cfLogin.exitCode !== 0 && cfLogin.output))) {
    renderLoginBox(cfCard, 'cloudflare', cfLogin);
  }
}

function renderFormView(target: HTMLElement) {
  const header = el(target, 'form-head');
  btn(header, '← Back', () => {
    editing = null;
    view = 'list';
    error = '';
    render();
  }, 'ghost', 'sm');
  text(header, editing ? 'Edit tunnel' : 'New tunnel', 'form-title', 'h2');

  const card = el(target, 'card');
  const options = providerOptions();
  const enabledOptions = options.filter((o) => !o.disabled);
  const noCreateProviders = !editing && enabledOptions.length === 0;

  if (!editing && enabledOptions.length > 0 && !enabledOptions.some((o) => o.id === form.provider)) {
    form.provider = enabledOptions[0]!.id;
    form.public = form.provider !== 'microsoft';
    form.publicConfirmed = false;
  }

  mountTextField(el(card), {
    label: 'Name',
    value: form.name,
    placeholder: 'e.g. web-app',
    onChange: (v) => { form.name = v; },
    helper: editing && form.provider === 'cloudflare-named' ? 'Cloudflare named tunnel names cannot be changed.' : 'A short label for this tunnel.',
  });

  if (noCreateProviders) {
    const bothMissing = !providers.microsoft.cli && !providers.cloudflare.cli;
    mountBanner(el(card), {
      tone: 'warning',
      title: bothMissing ? 'No tunnel CLIs installed' : 'No tunnel providers ready',
      body: bothMissing
        ? 'Install cloudflared or devtunnel on the OpenChamber server to create tunnels.'
        : 'Install missing CLIs or sign in under Accounts to enable a tunnel provider.',
      action: {
        label: 'Setup & accounts',
        onClick: () => {
          view = 'list';
          tab = 'accounts';
          render();
        },
      },
    });
    if (!providers.microsoft.cli || !providers.cloudflare.cli) {
      const docRow = el(card, 'helper-row');
      text(docRow, 'Install guides:', '', 'span');
      const docActions = el(docRow, 'actions');
      if (!providers.microsoft.cli) {
        btn(docActions, 'devtunnel docs ↗', () => void host.openUrl(CLI_GUIDES.microsoft.docsUrl), 'ghost', 'xs', false, false, true);
      }
      if (!providers.cloudflare.cli) {
        btn(docActions, 'cloudflared docs ↗', () => void host.openUrl(CLI_GUIDES.cloudflare.docsUrl), 'ghost', 'xs', false, false, true);
      }
    }
  }

  const providerSelect = mountSelect(el(card), {
    label: 'Provider',
    value: noCreateProviders ? null : form.provider,
    placeholder: noCreateProviders ? 'Setup required — open to inspect' : 'Select provider',
    disabled: Boolean(editing),
    options: (editing ? ALL_PROVIDER_OPTIONS : options) as SelectOption[],
    onChange: (v) => {
      const chosen = options.find((o) => o.id === v);
      if (!editing && chosen?.disabled) {
        providerSelect.update({ value: noCreateProviders ? null : form.provider });
        return;
      }
      form.provider = v as Provider;
      form.public = form.provider !== 'microsoft';
      form.publicConfirmed = false;
      render();
    },
  });

  if (!editing && !noCreateProviders && options.some((o) => o.disabled)) {
    const anyMissingCli = !providers.microsoft.cli || !providers.cloudflare.cli;
    const anyNeedsSignIn = (providers.microsoft.cli && !providers.microsoft.signedIn)
      || (providers.cloudflare.cli && !providers.cloudflare.signedIn);
    const hintText = anyMissingCli && anyNeedsSignIn
      ? 'Install missing CLIs or sign in under Accounts to unlock all providers.'
      : anyMissingCli
        ? 'Install missing CLIs under Accounts to unlock all providers.'
        : 'Sign in under Accounts to unlock all providers.';
    const hint = el(card, 'helper-row');
    text(hint, hintText, '', 'span');
    btn(
      hint,
      anyMissingCli ? 'Setup & accounts' : 'Accounts',
      () => {
        view = 'list';
        tab = 'accounts';
        render();
      },
      'ghost',
      'xs',
    );
  }

  if (editing && form.provider === 'microsoft' && !providers.microsoft.signedIn) {
    mountBanner(el(card), {
      tone: 'warning',
      title: providers.microsoft.cli ? 'Microsoft sign-in required' : 'devtunnel CLI not found',
      body: providers.microsoft.cli
        ? 'Sign in under Accounts before starting a Microsoft Dev Tunnel.'
        : 'Install devtunnel on the OpenChamber server and sign in before starting this tunnel.',
      action: {
        label: providers.microsoft.cli ? 'Accounts' : 'Install docs ↗',
        onClick: () => {
          if (providers.microsoft.cli) {
            view = 'list';
            tab = 'accounts';
            render();
          } else {
            void host.openUrl(CLI_GUIDES.microsoft.docsUrl);
          }
        },
      },
    });
  } else if (editing && form.provider === 'cloudflare-quick' && !providers.cloudflare.cli) {
    mountBanner(el(card), {
      tone: 'warning',
      title: 'cloudflared CLI not found',
      body: 'Install cloudflared on the OpenChamber server before starting this Quick tunnel.',
      action: {
        label: 'Install docs ↗',
        onClick: () => void host.openUrl(CLI_GUIDES.cloudflare.docsUrl),
      },
    });
  } else if (editing && form.provider === 'cloudflare-named' && !providers.cloudflare.signedIn) {
    mountBanner(el(card), {
      tone: 'warning',
      title: providers.cloudflare.cli ? 'Cloudflare sign-in required' : 'cloudflared CLI not found',
      body: providers.cloudflare.cli
        ? 'Named DNS tunnels require a Cloudflare origin certificate.'
        : 'Install cloudflared on the OpenChamber server and sign in before starting a named DNS tunnel.',
      action: {
        label: providers.cloudflare.cli ? 'Accounts' : 'Install docs ↗',
        onClick: () => {
          if (providers.cloudflare.cli) {
            view = 'list';
            tab = 'accounts';
            render();
          } else {
            void host.openUrl(CLI_GUIDES.cloudflare.docsUrl);
          }
        },
      },
    });
  }

  const grid = el(card, 'field-grid');
  mountTextField(el(grid), {
    label: 'Local port',
    value: form.port,
    placeholder: '3000',
    mono: true,
    onChange: (v) => { form.port = v; },
    helper: 'Port your local server listens on.',
  });
  const protocolSelect = mountSelect(el(grid), {
    label: 'Protocol',
    value: form.protocol,
    options: [
      { id: 'http', label: 'HTTP' },
      { id: 'https', label: 'HTTPS' },
    ],
    onChange: (v) => {
      form.protocol = v as 'http' | 'https';
      protocolSelect.update({ value: form.protocol });
    },
  });

  if (form.provider === 'cloudflare-named') {
    mountTextField(el(card), {
      label: 'Cloudflare DNS hostname',
      value: form.hostname,
      placeholder: 'app.example.com',
      disabled: Boolean(editing),
      onChange: (v) => { form.hostname = v; },
      helper: 'Requires a domain in your Cloudflare account. Cannot be changed after creation.',
    });
  }

  if (!noCreateProviders && form.provider === 'microsoft') {
    const publicSwitch = mountSwitch(el(card), {
      label: 'Allow anonymous public access',
      checked: form.public,
      onChange: (v) => {
        form.public = v;
        publicSwitch.update({ checked: v });
      },
      description: 'Off by default. Private links require Microsoft authentication.',
    });
  } else if (!noCreateProviders) {
    mountBanner(el(card), {
      tone: 'warning',
      title: 'Public tunnel',
      body:
        form.provider === 'cloudflare-quick'
          ? 'Quick tunnels expose your local app to anyone with the temporary URL. Do not expose sensitive services.'
          : 'This DNS hostname is publicly reachable. Configure Cloudflare Access separately if authentication is required.',
    });
    const confirmSwitch = mountSwitch(el(card), {
      label: 'Confirm public exposure',
      checked: form.publicConfirmed,
      onChange: (v) => {
        form.publicConfirmed = v;
        confirmSwitch.update({ checked: v });
      },
      description: 'Required for Cloudflare tunnels.',
    });
  }

  const keepSwitch = mountSwitch(el(card), {
    label: 'Keep running after OpenChamber exits',
    checked: form.keepRunning,
    onChange: (v) => {
      form.keepRunning = v;
      keepSwitch.update({ checked: v });
    },
    description: 'Off by default. Detaches the tunnel process in the background.',
  });

  const saving = isPending('save');
  const actions = el(card, 'actions');
  btn(
    actions,
    saving ? (editing ? 'Saving…' : 'Creating…') : editing ? 'Save changes' : 'Create tunnel',
    () => {
      if (noCreateProviders) return;
      const port = Number(form.port);
      if (!form.name.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
        error = 'Enter a tunnel name and a port between 1 and 65535.';
        render();
        return;
      }
      if (form.provider !== 'microsoft' && !form.publicConfirmed) {
        error = 'Turn on "Confirm public exposure" to create a public Cloudflare tunnel.';
        render();
        return;
      }
      const payload = {
        ...(editing ? { id: editing } : {}),
        name: form.name.trim(),
        provider: form.provider,
        port,
        protocol: form.protocol,
        public: form.provider === 'microsoft' ? form.public : true,
        keepRunning: form.keepRunning,
        ...(form.provider === 'cloudflare-named' ? { hostname: form.hostname.trim() } : {}),
      };
      void act(
        { kind: 'save' },
        editing ? 'PUT' : 'POST',
        '/tunnels',
        payload,
        editing ? 'Tunnel updated.' : 'Tunnel created.',
        () => {
          editing = null;
          view = 'list';
        },
      );
    },
    'default',
    'sm',
    noCreateProviders,
    saving,
  );
  btn(
    actions,
    'Cancel',
    () => {
      editing = null;
      view = 'list';
      error = '';
      render();
    },
    'ghost',
    'sm',
  );
}

function render() {
  if (!ready) return;
  root.replaceChildren();
  try {
    renderTopbar(root);
    if (error) mountBanner(el(root), { tone: 'error', title: 'Action failed', body: error });
    if (notice) mountBanner(el(root), { tone: 'success', title: notice });

    if (view === 'form') {
      renderFormView(root);
    } else if (tab === 'accounts') {
      renderAccountsTab(root);
    } else {
      renderTunnelsTab(root);
    }
  } catch (cause) {
    console.error('Tunnels panel could not render', cause);
    root.replaceChildren();
    mountBanner(el(root), {
      tone: 'error',
      title: 'Tunnels panel could not render',
      body: cause instanceof Error ? cause.message : String(cause),
    });
    btn(root, 'Retry', render, 'outline', 'sm');
  }
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (ready) return;
  ready = true;
  void refresh();
  void refreshLogin();
});

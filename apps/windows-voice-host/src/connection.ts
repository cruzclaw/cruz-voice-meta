/**
 * How the host reaches a voice server.
 *
 * `StaticConnection` is the demo server: a fixed address and a bearer token.
 * `CruzBackendConnection` is the CruzClaw backend: it signs in, finds the
 * employee, and asks for a single-use ticket every time a connection is opened,
 * because a ticket works for one connection only.
 *
 * Secrets stay in this module. Neither a password nor a token is ever put in an
 * error message, and nothing here logs.
 */

export interface ConnectionTarget {
  url: string;
  headers: Record<string, string>;
}

export interface ConnectionProvider {
  /** Where and how to open the next connection. Called again for every new connection. */
  resolve(): Promise<ConnectionTarget>;
}

/** Fatal errors are about the setup, such as a wrong password, so retrying without a change would only repeat them. */
export class ConnectionError extends Error {
  constructor(
    message: string,
    public readonly fatal = false,
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/** The demo server: one address and one bearer token. */
export class StaticConnection implements ConnectionProvider {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  resolve(): Promise<ConnectionTarget> {
    return Promise.resolve({ url: this.url, headers: { Authorization: `Bearer ${this.token}` } });
  }
}

export type Credentials = { email: string; password: string } | { accessToken: string; refreshToken?: string };

export interface CruzBackendOptions {
  /** For example https://api.example.com. Plain http is accepted for localhost only. */
  baseUrl: string;
  /** The employee to talk to: by id, or by name (case does not matter). */
  persona: { id?: string; name?: string };
  credentials: Credentials;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface Tokens {
  accessToken: string;
  refreshToken?: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Passwords and tokens must not cross the network in the clear. */
function secureBase(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConnectionError('The server address is not a valid URL.', true);
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return url;
  throw new ConnectionError('The server address must start with https:// (http:// is only allowed for localhost).', true);
}

export class CruzBackendConnection implements ConnectionProvider {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private tokens: Tokens | undefined;
  private personaId: string | undefined;
  private signingIn: Promise<Tokens> | undefined;

  constructor(private readonly options: CruzBackendOptions) {
    this.base = secureBase(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10000;
    if (!options.persona.id && !options.persona.name) {
      throw new ConnectionError('Say which employee to talk to, by id or by name.', true);
    }
    if ('accessToken' in options.credentials) this.tokens = { ...options.credentials };
  }

  async resolve(): Promise<ConnectionTarget> {
    const personaId = await this.findPersona();
    const res = await this.authorized((token) => this.call('POST', '/api/voice/ticket', token, { personaId }));
    const body = await this.json(res);
    if (!res.ok) throw this.refusal(res.status, body);

    const data = (body as { data?: { ticket?: unknown; path?: unknown } } | undefined)?.data;
    if (typeof data?.ticket !== 'string' || !data.ticket || typeof data.path !== 'string' || !data.path.startsWith('/')) {
      throw new ConnectionError('The server did not send a usable ticket.');
    }
    const ws = new URL(this.base.href);
    ws.protocol = this.base.protocol === 'https:' ? 'wss:' : 'ws:';
    ws.pathname = data.path;
    ws.search = `?ticket=${encodeURIComponent(data.ticket)}`;
    // The ticket is the credential, so no header is needed.
    return { url: ws.toString(), headers: {} };
  }

  // ---- finding the employee ----

  private async findPersona(): Promise<string> {
    if (this.personaId) return this.personaId;
    if (this.options.persona.id) return (this.personaId = this.options.persona.id);

    const wanted = (this.options.persona.name ?? '').trim().toLowerCase();
    const res = await this.authorized((token) => this.call('GET', '/api/personas', token));
    const body = await this.json(res);
    if (!res.ok) throw this.refusal(res.status, body);
    const list = ((body as { data?: { personas?: unknown } } | undefined)?.data?.personas ?? []) as Array<{ id?: unknown; name?: unknown }>;
    const people = list.filter((p): p is { id: string; name: string } => typeof p.id === 'string' && typeof p.name === 'string');
    const matches = people.filter((p) => p.name.trim().toLowerCase() === wanted);
    if (matches.length === 1) return (this.personaId = matches[0]!.id);
    if (matches.length > 1) throw new ConnectionError(`More than one employee is called "${this.options.persona.name}". Use the id instead.`, true);
    const names = people.map((p) => p.name).slice(0, 10).join(', ');
    throw new ConnectionError(`No employee is called "${this.options.persona.name}".${names ? ` These exist: ${names}.` : ''}`, true);
  }

  // ---- signing in ----

  /** Runs a request with the access token. If the server says it has expired, renews it and tries once more. */
  private async authorized(request: (token: string) => Promise<Response>): Promise<Response> {
    const first = await request((await this.ensureTokens()).accessToken);
    if (first.status !== 401) return first;
    return request((await this.renew()).accessToken);
  }

  private async ensureTokens(): Promise<Tokens> {
    return this.tokens ?? this.signIn();
  }

  private async renew(): Promise<Tokens> {
    const refreshToken = this.tokens?.refreshToken;
    this.tokens = undefined;
    if (refreshToken) {
      try {
        const res = await this.call('POST', '/api/auth/refresh', undefined, { refreshToken });
        const tokens = this.readTokens(await this.json(res));
        if (res.ok && tokens) return (this.tokens = tokens);
      } catch {
        // Fall through to a full sign-in if there are credentials for one.
      }
    }
    return this.signIn();
  }

  /** One sign-in at a time, however many requests ask for it. */
  private signIn(): Promise<Tokens> {
    if (!('email' in this.options.credentials)) {
      return Promise.reject(new ConnectionError('The access token is no longer valid. Give the app a new one.', true));
    }
    const { email, password } = this.options.credentials;
    this.signingIn ??= (async () => {
      try {
        const res = await this.call('POST', '/api/auth/login', undefined, { email, password });
        const body = await this.json(res);
        if ((body as { data?: { requiresAdminOtp?: boolean } } | undefined)?.data?.requiresAdminOtp) {
          throw new ConnectionError('This account needs an emailed code to sign in, which this app cannot do. Use an access token instead.', true);
        }
        const tokens = this.readTokens(body);
        if (!res.ok || !tokens) {
          if (res.status === 429) throw new ConnectionError('Too many sign-in attempts. Wait a minute and try again.');
          throw new ConnectionError(res.status >= 500 ? 'The Cruz server could not sign you in right now.' : 'The email or password was not accepted.', res.status < 500);
        }
        return (this.tokens = tokens);
      } finally {
        this.signingIn = undefined;
      }
    })();
    return this.signingIn;
  }

  private readTokens(body: unknown): Tokens | undefined {
    const t = (body as { data?: { tokens?: { accessToken?: unknown; refreshToken?: unknown } } } | undefined)?.data?.tokens;
    if (!t || typeof t.accessToken !== 'string' || !t.accessToken) return undefined;
    return { accessToken: t.accessToken, ...(typeof t.refreshToken === 'string' && t.refreshToken ? { refreshToken: t.refreshToken } : {}) };
  }

  // ---- talking to the server ----

  private async call(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(path, this.base).toString(), {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // The reason can name the address and nothing else useful, so it is not passed on.
      throw new ConnectionError('Could not reach the Cruz server.');
    }
  }

  private async json(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }

  /** Turns a refusal into words for the person. The server's own text is not repeated: it may carry detail. */
  private refusal(status: number, body: unknown): ConnectionError {
    const code = (body as { error?: { code?: unknown } } | undefined)?.error?.code;
    if (status === 401) return new ConnectionError('The server did not accept the sign-in.', true);
    if (status === 403) return new ConnectionError('Voice is not turned on for this account.', true);
    if (status === 404) return new ConnectionError('The server could not find that employee.', true);
    if (status === 429) return new ConnectionError('Too many attempts. Wait a minute and try again.');
    if (status === 503 && code === 'VOICE_NOT_CONFIGURED') return new ConnectionError('Voice is not available on this server.', true);
    return new ConnectionError(`The Cruz server answered ${status}.`);
  }
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectionError, CruzBackendConnection, StaticConnection, type CruzBackendOptions } from '../src/connection.js';

const PASSWORD = 'correct horse battery staple';
const ACCESS = 'access-token-AAAA';
const REFRESH = 'refresh-token-RRRR';
const BASE = 'https://api.example.test';

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  body: any;
}

/** A pretend Cruz server. `handlers` return [status, body] for a path, and may return different answers over time. */
function server(handlers: Record<string, (seen: Seen, count: number) => [number, unknown]>) {
  const seen: Seen[] = [];
  const counts: Record<string, number> = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const entry: Seen = { method: init.method ?? 'GET', path, auth: headers.authorization, body: init.body ? JSON.parse(init.body as string) : undefined };
    seen.push(entry);
    counts[path] = (counts[path] ?? 0) + 1;
    const handler = handlers[path];
    const [status, body] = handler ? handler(entry, counts[path]!) : [404, {}];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen, count: (path: string) => counts[path] ?? 0 };
}

const tokens = (n = 1) => ({ success: true, data: { tokens: { accessToken: `${ACCESS}${n}`, refreshToken: `${REFRESH}${n}` } } });
const ticket = (n = 1) => ({ success: true, data: { ticket: `ticket-${n}`, expiresInSeconds: 60, path: '/api/voice/ws' } });
const personas = (...names: string[]) => ({ success: true, data: { personas: names.map((name, i) => ({ id: `persona-${i + 1}`, name })) } });

const make = (s: ReturnType<typeof server>, over: Partial<CruzBackendOptions> = {}) =>
  new CruzBackendConnection({
    baseUrl: BASE,
    persona: { id: 'persona-1' },
    credentials: { email: 'owner@example.com', password: PASSWORD },
    fetchImpl: s.fetchImpl,
    ...over,
  });

const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a failure');
};

describe('StaticConnection', () => {
  it('is the demo server: the fixed address and a bearer token', async () => {
    assert.deepEqual(await new StaticConnection('ws://127.0.0.1:8787', 'tok').resolve(), {
      url: 'ws://127.0.0.1:8787',
      headers: { Authorization: 'Bearer tok' },
    });
  });
});

describe('CruzBackendConnection: the normal way in', () => {
  it('signs in, asks for a ticket for the employee, and connects over wss with the ticket as the only credential', async () => {
    const s = server({
      '/api/auth/login': () => [200, tokens()],
      '/api/voice/ticket': () => [200, ticket()],
    });
    const target = await make(s).resolve();

    assert.equal(target.url, 'wss://api.example.test/api/voice/ws?ticket=ticket-1');
    assert.deepEqual(target.headers, {});
    assert.deepEqual(s.seen[0], { method: 'POST', path: '/api/auth/login', auth: undefined, body: { email: 'owner@example.com', password: PASSWORD } });
    assert.deepEqual(s.seen[1], { method: 'POST', path: '/api/voice/ticket', auth: `Bearer ${ACCESS}1`, body: { personaId: 'persona-1' } });
  });

  it('asks for a new ticket on every connection, because a ticket works once, and signs in only once', async () => {
    let n = 0;
    const s = server({ '/api/auth/login': () => [200, tokens()], '/api/voice/ticket': () => [200, ticket(++n)] });
    const connection = make(s);
    assert.match((await connection.resolve()).url, /ticket=ticket-1$/);
    assert.match((await connection.resolve()).url, /ticket=ticket-2$/);
    assert.equal(s.count('/api/auth/login'), 1);
    assert.equal(s.count('/api/voice/ticket'), 2);
  });

  it('uses an access token as given, with no sign-in', async () => {
    const s = server({ '/api/voice/ticket': () => [200, ticket()] });
    const target = await make(s, { credentials: { accessToken: 'given-token' } }).resolve();
    assert.match(target.url, /ticket=ticket-1$/);
    assert.equal(s.count('/api/auth/login'), 0);
    assert.equal(s.seen[0]!.auth, 'Bearer given-token');
  });

  it('uses ws:// for a local http server and encodes the ticket', async () => {
    const s = server({ '/api/voice/ticket': () => [200, { data: { ticket: 'a b/c+d', path: '/api/voice/ws' } }] });
    const target = await make(s, { baseUrl: 'http://localhost:3000', credentials: { accessToken: 't' } }).resolve();
    assert.equal(target.url, 'ws://localhost:3000/api/voice/ws?ticket=a%20b%2Fc%2Bd');
  });
});

describe('CruzBackendConnection: finding the employee', () => {
  it('finds an employee by name, ignoring case and spaces at the ends, and remembers the id', async () => {
    const s = server({
      '/api/auth/login': () => [200, tokens()],
      '/api/personas': () => [200, personas('Marie', 'Tesla')],
      '/api/voice/ticket': () => [200, ticket()],
    });
    const connection = make(s, { persona: { name: '  tesla ' } });
    await connection.resolve();
    await connection.resolve();
    assert.equal(s.seen.find((x) => x.path === '/api/voice/ticket')!.body.personaId, 'persona-2');
    assert.equal(s.count('/api/personas'), 1, 'looked up once, not for every connection');
  });

  it('says which employees exist when the name matches none, and refuses a name that matches two', async () => {
    const s = server({ '/api/auth/login': () => [200, tokens()], '/api/personas': () => [200, personas('Marie', 'Tesla')] });
    const none = await fails(make(s, { persona: { name: 'Edison' } }).resolve());
    assert.ok(none instanceof ConnectionError && none.fatal);
    assert.match(none.message, /No employee is called "Edison"\. These exist: Marie, Tesla\./);

    const twice = server({ '/api/auth/login': () => [200, tokens()], '/api/personas': () => [200, personas('Tesla', 'tesla')] });
    const many = await fails(make(twice, { persona: { name: 'Tesla' } }).resolve());
    assert.match(many.message, /More than one employee/);
  });

  it('needs an id or a name', () => {
    assert.throws(() => new CruzBackendConnection({ baseUrl: BASE, persona: {}, credentials: { accessToken: 't' } }), /by id or by name/);
  });
});

describe('CruzBackendConnection: tokens that expire', () => {
  it('renews with the refresh token when the server says the access token has expired, then carries on', async () => {
    const s = server({
      '/api/voice/ticket': (seen) => (seen.auth === `Bearer ${ACCESS}2` ? [200, ticket()] : [401, {}]),
      '/api/auth/refresh': () => [200, tokens(2)],
    });
    const target = await make(s, { credentials: { accessToken: 'stale', refreshToken: 'old-refresh' } }).resolve();
    assert.match(target.url, /ticket=ticket-1$/);
    assert.deepEqual(s.seen.find((x) => x.path === '/api/auth/refresh')!.body, { refreshToken: 'old-refresh' });
    assert.equal(s.count('/api/voice/ticket'), 2);
  });

  it('signs in again with the password if the refresh token no longer works', async () => {
    const s = server({
      '/api/voice/ticket': (seen) => (seen.auth === `Bearer ${ACCESS}9` ? [200, ticket()] : [401, {}]),
      '/api/auth/refresh': () => [401, {}],
      '/api/auth/login': () => [200, tokens(9)],
    });
    const connection = make(s);
    // Start with tokens that the server has since forgotten.
    (connection as any).tokens = { accessToken: 'stale', refreshToken: 'dead' };
    assert.match((await connection.resolve()).url, /ticket=ticket-1$/);
    assert.equal(s.count('/api/auth/login'), 1);
  });

  it('asks for a new token, as a fatal problem, when a pasted token has expired and cannot be renewed', async () => {
    const s = server({ '/api/voice/ticket': () => [401, {}] });
    const error = await fails(make(s, { credentials: { accessToken: 'stale' } }).resolve());
    assert.ok(error instanceof ConnectionError && error.fatal);
    assert.match(error.message, /no longer valid/);
  });

  it('signs in only once when several connections ask at the same moment', async () => {
    const s = server({ '/api/auth/login': () => [200, tokens()], '/api/voice/ticket': () => [200, ticket()] });
    const connection = make(s);
    await Promise.all([connection.resolve(), connection.resolve(), connection.resolve()]);
    assert.equal(s.count('/api/auth/login'), 1);
  });
});

describe('CruzBackendConnection: refusals, in words for the person', () => {
  const cases: Array<[string, [number, unknown], RegExp, boolean]> = [
    ['voice not turned on', [403, { error: { code: 'FORBIDDEN' } }], /Voice is not turned on for this account/, true],
    ['an employee that is not theirs', [404, {}], /could not find that employee/, true],
    ['too many tries', [429, {}], /Too many attempts/, false],
    ['a server without a Meta key', [503, { error: { code: 'VOICE_NOT_CONFIGURED' } }], /Voice is not available on this server/, true],
    ['a server error', [500, {}], /answered 500/, false],
  ];
  for (const [name, answer, message, fatal] of cases) {
    it(`${name}`, async () => {
      const s = server({ '/api/auth/login': () => [200, tokens()], '/api/voice/ticket': () => answer });
      const error = await fails(make(s).resolve());
      assert.ok(error instanceof ConnectionError);
      assert.match(error.message, message);
      assert.equal(error.fatal, fatal);
    });
  }

  it('reports a wrong password as fatal, and an overloaded sign-in as worth retrying', async () => {
    const bad = await fails(make(server({ '/api/auth/login': () => [401, { error: { message: 'Invalid credentials' } }] })).resolve());
    assert.ok(bad instanceof ConnectionError && bad.fatal);
    assert.match(bad.message, /email or password was not accepted/);
    const busy = await fails(make(server({ '/api/auth/login': () => [429, {}] })).resolve());
    assert.ok(busy instanceof ConnectionError && !busy.fatal);
  });

  it('explains that an admin account needing an emailed code cannot sign in here', async () => {
    const s = server({ '/api/auth/login': () => [200, { success: true, data: { requiresAdminOtp: true, challengeId: 'c' } }] });
    const error = await fails(make(s).resolve());
    assert.ok(error instanceof ConnectionError && error.fatal);
    assert.match(error.message, /emailed code/);
  });

  it('treats an answer without a usable ticket as a problem, not a connection', async () => {
    for (const body of [{ data: {} }, { data: { ticket: 'x', path: 'not-absolute' } }, { data: { ticket: '', path: '/p' } }, {}]) {
      const s = server({ '/api/auth/login': () => [200, tokens()], '/api/voice/ticket': () => [200, body] });
      const error = await fails(make(s).resolve());
      assert.match(error.message, /usable ticket/);
    }
  });

  it('says it could not reach the server, naming nothing else', async () => {
    const error = await fails(
      make(server({}), {
        fetchImpl: (async () => {
          throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND api.example.test with ${PASSWORD}`);
        }) as unknown as typeof fetch,
      }).resolve(),
    );
    assert.equal(error.message, 'Could not reach the Cruz server.');
  });
});

describe('CruzBackendConnection: keeping secrets and refusing insecure addresses', () => {
  it('refuses plain http for anything but localhost, so a password cannot cross the network in the clear', () => {
    for (const baseUrl of ['http://api.example.test', 'http://192.168.1.5:3000', 'ftp://x.test', 'not a url']) {
      assert.throws(() => new CruzBackendConnection({ baseUrl, persona: { id: 'p' }, credentials: { accessToken: 't' } }), ConnectionError, baseUrl);
    }
    for (const baseUrl of ['https://api.example.test', 'http://localhost:3000', 'http://127.0.0.1:3000']) {
      assert.doesNotThrow(() => new CruzBackendConnection({ baseUrl, persona: { id: 'p' }, credentials: { accessToken: 't' } }), baseUrl);
    }
  });

  it('never puts a password or a token in any error it raises', async () => {
    const attempts = [
      make(server({ '/api/auth/login': () => [401, { echo: PASSWORD }] })).resolve(),
      make(server({ '/api/auth/login': () => [200, tokens()], '/api/voice/ticket': () => [403, { echo: `${ACCESS}1 ${REFRESH}1 ${PASSWORD}` }] })).resolve(),
      make(server({ '/api/auth/login': () => [200, tokens()], '/api/voice/ticket': () => [500, { echo: `${ACCESS}1` }] })).resolve(),
      make(server({}), { fetchImpl: (async () => { throw new Error(`${PASSWORD} ${ACCESS}`); }) as unknown as typeof fetch }).resolve(),
    ];
    for (const attempt of attempts) {
      const error = await fails(attempt);
      for (const secret of [PASSWORD, ACCESS, REFRESH, 'owner@example.com']) assert.equal(error.message.includes(secret), false, error.message);
    }
  });
});

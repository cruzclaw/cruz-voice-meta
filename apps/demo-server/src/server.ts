import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData } from 'ws';
import { LIMITS, parseVoiceFeatureConfig, type VoiceFeatureConfig } from '@cruzclaw/voice-core';
import { MockEmployeeBackend } from '@cruzclaw/mock-employee';
import { greetingFor, VoiceSession, type Providers } from '@cruzclaw/voice-server';

export interface DemoAccount {
  /** Bearer token the client presents. Maps to exactly one tenant. */
  token: string;
  tenantKey: string;
  features: unknown;
  /** How the assistant addresses this person. Kept on the server; a client cannot set it. */
  displayName?: string;
}

export interface DemoServerOptions {
  accounts: DemoAccount[];
  providers: Providers;
  backend?: MockEmployeeBackend;
  /** Browser origins allowed to connect. Native clients send no Origin and are not affected. */
  allowedOrigins?: string[];
  /** When true, VOICE_FEATURE_DISABLED-style kill switch: every session is refused. */
  killSwitch?: boolean;
  /** How often the demo worker advances tasks, in ms. */
  workerIntervalMs?: number;
  /** Receives the real cause of a provider failure, for the operator's log. */
  onProviderError?: (error: unknown) => void;
}

export interface DemoServer {
  server: Server;
  backend: MockEmployeeBackend;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null;
  return match?.[1];
}

export function createDemoServer(options: DemoServerOptions): DemoServer {
  const backend = options.backend ?? new MockEmployeeBackend();
  const origins = new Set(options.allowedOrigins ?? []);
  const accounts = options.accounts.map((a) => ({ ...a, hash: digest(a.token) }));
  const drivers = new Set<NodeJS.Timeout>();
  const sessions = new Set<VoiceSession>();

  /** Constant-time lookup so token checks do not leak how much of a token matched. */
  const authenticate = (req: IncomingMessage) => {
    const token = bearer(req);
    if (!token) return undefined;
    const hash = digest(token);
    let found: (typeof accounts)[number] | undefined;
    for (const account of accounts) if (timingSafeEqual(hash, account.hash)) found = account;
    return found;
  };

  /** Demo worker: advances a task until it finishes. Approval-gated tasks wait for the owner. */
  const drive = (tenantKey: string, taskId: string): void => {
    const timer = setInterval(() => {
      backend.advance(tenantKey, taskId);
      const state = backend.tenant(tenantKey).tasks.get(taskId)?.state;
      if (!state || ['confirmed', 'cancelled', 'rejected', 'failed'].includes(state)) {
        clearInterval(timer);
        drivers.delete(timer);
      }
    }, options.workerIntervalMs ?? 400);
    drivers.add(timer);
  };

  const server = createServer((req, res) => {
    const account = authenticate(req);
    const match = /^\/demo\/approvals\/([\w-]{1,128})\/(approved|rejected)$/.exec(req.url ?? '');
    if (req.method === 'POST' && match) {
      if (!account) {
        res.writeHead(401).end();
        return;
      }
      try {
        backend.decide(account.tenantKey, match[1]!, match[2] as 'approved' | 'rejected');
        res.writeHead(204).end();
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxJsonBytes });

  const refuse = (socket: Duplex, status: string): void => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) return refuse(socket, '403 Forbidden');
    const account = authenticate(req);
    if (!account) return refuse(socket, '401 Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const features: VoiceFeatureConfig = options.killSwitch
        ? { voiceEnabled: false, wakePhraseConsent: false }
        : parseVoiceFeatureConfig(account.features);
      const session = new VoiceSession({
        sessionId: randomUUID(),
        host: backend.hostFor(account.tenantKey),
        providers: options.providers,
        features,
        greeting: greetingFor(account.displayName),
        onTaskReady: (taskId) => drive(account.tenantKey, taskId),
        ...(options.onProviderError ? { onProviderError: options.onProviderError } : {}),
        transport: {
          sendJson: (message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message)),
          sendAudio: (frame) => ws.readyState === ws.OPEN && ws.send(frame, { binary: true }),
          close: () => ws.close(1000),
        },
      });
      sessions.add(session);
      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) session.handleBinary(Array.isArray(data) ? Buffer.concat(data) : new Uint8Array(data as Buffer));
        else session.handleText(data.toString());
      });
      ws.on('close', () => {
        session.close();
        sessions.delete(session);
      });
      ws.on('error', () => ws.terminate());
    });
  });

  return {
    server,
    backend,
    listen: (port, host = '127.0.0.1') =>
      new Promise((resolve) => {
        server.listen(port, host, () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        drivers.forEach(clearInterval);
        sessions.forEach((s) => s.close());
        wss.clients.forEach((c) => c.terminate());
        server.close(() => resolve());
      }),
  };
}

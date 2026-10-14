import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { createLogger } from './util/logger.ts';
import { UpstreamClient } from './proxy/upstream.ts';
import { ProxyHandler } from './proxy/handler.ts';
import { ArchiveStore } from './archive/store.ts';
import { ArchiveReplay } from './archive/replay.ts';
import { Crawler } from './archive/crawler.ts';
import { CaptureIngest } from './archive/capture.ts';
import { RestFormIngest } from './archive/rest-form.ts';import { ProxyServer } from './server/http-server.ts';

/**
 * Entry point.
 *
 * Wiring is explicit rather than container-based: there are only seven
 * collaborators and the dependency graph is a tree, so a container would add
 * indirection without removing work.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      host: { type: 'string' },
      port: { type: 'string', short: 'p' },
      'data-dir': { type: 'string' },
      'enable-security': { type: 'boolean' },
      'log-level': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const fileConfig = await loadConfig(values.config);
  const config = applyOverrides(fileConfig, values);
  const logger = createLogger(config);

  const upstream = new UpstreamClient(config);
  const store = await ArchiveStore.open(config.archive);
  const proxy = new ProxyHandler(config, logger, upstream);
  const replay = new ArchiveReplay(config, logger, store);
  const crawler = new Crawler(config, logger, upstream, store);
  const capture = new CaptureIngest(config, logger, upstream, store);
  const restForm = new RestFormIngest(config, logger, store);

  const server = new ProxyServer(config, logger, {
    proxy,
    upstream,
    store,
    replay,
    crawler,
    capture,
    restForm,
  });
  const running = await server.listen();

  logger.info(
    {
      url: `http://${config.server.host}:${running.port}`,
      security: config.security.enabled ? 'enabled' : 'DISABLED (open proxy)',
    },
    'proxy listening',
  );

  if (!config.security.enabled) {
    logger.warn(
      'SSRF and DNS-rebinding defences are off. This instance will fetch any URL it is given, ' +
        'including internal addresses. Set security.enabled=true to turn them on.',
    );
  }

  let closing = false;
  const stop = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    try {
      await running.close();
      store.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

function applyOverrides(
  config: Awaited<ReturnType<typeof loadConfig>>,
  values: Record<string, string | boolean | undefined>,
): typeof config {
  const next = structuredClone(config);
  if (typeof values['host'] === 'string') next.server.host = values['host'];
  if (typeof values['port'] === 'string') next.server.port = Number.parseInt(values['port'], 10);
  if (typeof values['data-dir'] === 'string') next.archive.dataDir = values['data-dir'];
  if (values['enable-security'] === true) next.security.enabled = true;
  if (typeof values['log-level'] === 'string') {
    next.log.level = values['log-level'] as typeof next.log.level;
  }
  return next;
}

function printUsage(): void {
  process.stdout.write(
    `advanced-proxy-service

Usage:
  node src/index.ts [options]

Options:
  -c, --config <file>       Path to a JSON configuration file
      --host <address>      Interface to bind (default 127.0.0.1)
  -p, --port <number>       Port to listen on (default 8080)
      --data-dir <path>     Where archives are stored (default ./data)
      --enable-security     Turn on SSRF and DNS-rebinding defences
      --log-level <level>   trace|debug|info|warn|error|fatal|silent
  -h, --help                Show this message

Browse a site through the proxy:
  http://localhost:8080/proxy/https%3A%2F%2Fexample.com%2F

Archive a site for offline replay (POSIX shell):
  curl -X POST localhost:8080/api/archives -H 'content-type: application/json' \\
       -d '{"url":"https://example.com"}'

  On cmd.exe single quotes are not quotes -- the body needs escaped double
  quotes, and an unescaped & in the URL ends the command. See the README
  section "Archiving with curl on Windows", or let curl read the body:
  curl -X POST localhost:8080/api/archives -H "content-type: application/json" -d @body.json

Replay an archive offline:
  http://localhost:8080/archive/<id>/plain/https%3A%2F%2Fexample.com%2F
`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress, BlockedDestinationError, resolveAndValidate } from '../src/proxy/security/ssrf.ts';
import { parseConfig } from '../src/config.ts';

const on = parseConfig({ security: { enabled: true } }).security;
const off = parseConfig({ security: { enabled: false } }).security;

test('blocks IPv4 loopback, private and link-local ranges', () => {
  for (const address of [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // carrier-grade NAT
    '0.0.0.0',
    '224.0.0.1', // multicast
  ]) {
    assert.equal(isBlockedAddress(address, on), true, `${address} should be blocked`);
  }
});

test('allows ordinary public IPv4 addresses', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '11.0.0.1']) {
    assert.equal(isBlockedAddress(address, on), false, `${address} should be allowed`);
  }
});

test('blocks IPv6 loopback, unique-local and link-local addresses', () => {
  for (const address of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1']) {
    assert.equal(isBlockedAddress(address, on), true, `${address} should be blocked`);
  }
});

test('blocks IPv4-mapped IPv6 that hides a private address', () => {
  // ::ffff:127.0.0.1 would slip through a naive prefix check.
  assert.equal(isBlockedAddress('::ffff:127.0.0.1', on), true);
  assert.equal(isBlockedAddress('::ffff:169.254.169.254', on), true);
  assert.equal(isBlockedAddress('::ffff:8.8.8.8', on), false);
});

test('treats an unparseable address as blocked', () => {
  assert.equal(isBlockedAddress('not-an-ip', on), true);
});

test('honours extra configured CIDRs', () => {
  const config = parseConfig({ security: { enabled: true, blockedCidrs: ['203.0.113.0/24'] } }).security;
  assert.equal(isBlockedAddress('203.0.113.5', config), true);
  assert.equal(isBlockedAddress('203.0.114.5', config), false);
});

test('resolveAndValidate is a no-op when security is disabled', async () => {
  const result = await resolveAndValidate(new URL('http://127.0.0.1/'), off);
  assert.equal(result, null);
});

test('resolveAndValidate rejects loopback literals when enabled', async () => {
  await assert.rejects(
    () => resolveAndValidate(new URL('http://127.0.0.1/'), on),
    (error: unknown) => error instanceof BlockedDestinationError,
  );
});

test('resolveAndValidate rejects the cloud metadata address', async () => {
  await assert.rejects(
    () => resolveAndValidate(new URL('http://169.254.169.254/latest/meta-data/'), on),
    (error: unknown) => error instanceof BlockedDestinationError,
  );
});

test('resolveAndValidate rejects localhost by name', async () => {
  for (const host of ['localhost', 'foo.localhost', 'printer.local']) {
    await assert.rejects(
      () => resolveAndValidate(new URL(`http://${host}/`), on),
      (error: unknown) => error instanceof BlockedDestinationError,
      `${host} should be rejected`,
    );
  }
});

test('resolveAndValidate honours the blockedHosts list', async () => {
  const config = parseConfig({ security: { enabled: true, blockedHosts: ['evil.test'] } }).security;
  await assert.rejects(
    () => resolveAndValidate(new URL('http://evil.test/'), config),
    (error: unknown) => error instanceof BlockedDestinationError,
  );
});

test('resolveAndValidate pins a public literal IP to itself', async () => {
  const result = await resolveAndValidate(new URL('http://93.184.216.34/'), on);
  assert.equal(result?.address, '93.184.216.34');
  assert.equal(result?.family, 4);
});

test('security defaults to disabled', () => {
  const config = parseConfig({});
  assert.equal(config.security.enabled, false);
  assert.equal(config.security.blockPrivateRanges, true);
});

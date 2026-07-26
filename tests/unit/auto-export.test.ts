// SPDX-License-Identifier: MIT
/**
 * Automatic export scheduler — SPEC §5.4 (commit 3).
 *
 * These cover the three properties that make auto-export safe to depend on:
 * the path is fixed, repeated mutations coalesce, and a failing run cannot
 * escape. The wiring into real mutations is covered in
 * tests/integration/auto-export.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

import {
  DEFAULT_AUTOEXPORT_DEBOUNCE_MS,
  autoExportPath,
  createAutoExporter,
} from '../../src/lib/auto-export.js';
import { resolveExportPath } from '../../src/lib/export-team-config.js';

describe('autoExportPath — §5.4 fixed shape', () => {
  it('is <baseWorkDir>/teams/<team>/<team>.autoexport.yaml', () => {
    expect(autoExportPath('/work', 'blue')).toBe(
      path.join('/work', 'teams', 'blue', 'blue.autoexport.yaml'),
    );
  });

  it('ignores last_config_path, unlike the §5.1 resolution', () => {
    // The distinction is the whole point: /export may write the operator's own
    // file, an automatic write may never. Same team, deliberately different
    // answers — if these ever agree, auto-export has started clobbering.
    const recorded = '/somewhere/operator-owned.yaml';
    expect(resolveExportPath(undefined, recorded, '/work', 'blue')).toBe(recorded);
    expect(autoExportPath('/work', 'blue')).not.toBe(recorded);
    expect(autoExportPath('/work', 'blue')).toContain('.autoexport.yaml');
  });
});

describe('createAutoExporter — debounce and failure isolation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('defaults to the §5.4 5s window', () => {
    expect(DEFAULT_AUTOEXPORT_DEBOUNCE_MS).toBe(5000);
  });

  it('coalesces rapid mutations in one team into a single write', () => {
    const run = vi.fn();
    const exporter = createAutoExporter({ debounceMs: 5000 });
    for (let i = 0; i < 8; i++) exporter.schedule('blue', run);
    expect(run).not.toHaveBeenCalled(); // nothing fires inside the window
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
    exporter.dispose();
  });

  it('keeps separate teams independent', () => {
    const blue = vi.fn();
    const green = vi.fn();
    const exporter = createAutoExporter({ debounceMs: 100 });
    exporter.schedule('blue', blue);
    exporter.schedule('green', green);
    expect(exporter.pending()).toBe(2);
    vi.advanceTimersByTime(100);
    expect(blue).toHaveBeenCalledTimes(1);
    expect(green).toHaveBeenCalledTimes(1);
    exporter.dispose();
  });

  it('runs again after the window has elapsed', () => {
    const run = vi.fn();
    const exporter = createAutoExporter({ debounceMs: 100 });
    exporter.schedule('blue', run);
    vi.advanceTimersByTime(100);
    exporter.schedule('blue', run);
    vi.advanceTimersByTime(100);
    expect(run).toHaveBeenCalledTimes(2);
    exporter.dispose();
  });

  it('swallows a synchronous throw and reports it', () => {
    const onError = vi.fn();
    const exporter = createAutoExporter({ debounceMs: 10, onError });
    exporter.schedule('blue', () => { throw new Error('disk on fire'); });
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('disk on fire');
    expect(onError.mock.calls[0][1]).toBe('blue');
    exporter.dispose();
  });

  it('swallows an async rejection and reports it', async () => {
    const onError = vi.fn();
    const exporter = createAutoExporter({ debounceMs: 10, onError });
    exporter.schedule('blue', async () => { throw new Error('async boom'); });
    vi.advanceTimersByTime(10);
    await Promise.resolve(); // let the rejection settle
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe('async boom');
    exporter.dispose();
  });

  it('schedule() itself never throws, even when the run will fail', () => {
    const exporter = createAutoExporter({ debounceMs: 10 });
    // The caller is a mutation handler; scheduling must be inert for it.
    expect(() => exporter.schedule('blue', () => { throw new Error('x'); })).not.toThrow();
    exporter.dispose();
  });

  it('dispose() cancels pending work so no timer outlives the manager', () => {
    const run = vi.fn();
    const exporter = createAutoExporter({ debounceMs: 1000 });
    exporter.schedule('blue', run);
    expect(exporter.pending()).toBe(1);
    exporter.dispose();
    expect(exporter.pending()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  parseStorageClasses,
  resolveWorkloadStorage,
  storageMiB,
} from '../src/workload-storage.js';

describe("a mounted workload's PVC caps (workload sandboxes spec §5.1, §6.3)", () => {
  it('parses the class allowlist, refusing anything but <class>:rwo|rwx, once each', () => {
    expect([...parseStorageClasses(' fast:rwo, nfs:rwx ,')]).toEqual([
      ['fast', 'rwo'],
      ['nfs', 'rwx'],
    ]);
    expect(parseStorageClasses(undefined).size).toBe(0);
    for (const bad of ['fast', 'fast:rwop', 'Fast:rwo', 'a:rwo:x', 'a:rwo,a:rwx']) {
      expect(() => parseStorageClasses(bad), bad).toThrow(/MOCA_WORKLOAD_STORAGE_CLASSES/);
    }
  });

  it('sizes in Mi or Gi only', () => {
    expect(storageMiB('2Gi')).toBe(2048);
    expect(storageMiB('512Mi')).toBe(512);
    for (const bad of ['0Gi', '1G', '1Ti', 1, '01Gi'])
      expect(storageMiB(bad), String(bad)).toBeNull();
  });

  it('without an allowlist: the default class, ReadWriteOnce, and no class may be named', () => {
    const caps = { maxMiB: 1024, classes: new Map() };
    expect(resolveWorkloadStorage({ size: '1Gi' }, caps)).toEqual({ size: '1Gi', access: 'rwo' });
    expect(resolveWorkloadStorage({ size: '2Gi' }, caps)).toBe('workspace_size_invalid');
    expect(resolveWorkloadStorage({ size: '1Gi', storageClass: 'x' }, caps)).toBe(
      'storage_class_not_allowed',
    );
  });

  it('with one: the first class when none is named, and its access mode', () => {
    const caps = { maxMiB: 1024, classes: parseStorageClasses('fast:rwo,nfs:rwx') };
    expect(resolveWorkloadStorage({ size: '1Gi' }, caps)).toEqual({
      size: '1Gi',
      storageClass: 'fast',
      access: 'rwo',
    });
    expect(resolveWorkloadStorage({ size: '1Gi', storageClass: 'nfs' }, caps)).toMatchObject({
      access: 'rwx',
    });
    expect(resolveWorkloadStorage({ size: '1Gi', storageClass: 'slow' }, caps)).toBe(
      'storage_class_not_allowed',
    );
  });

  it('treats storageClass: null as naming no class, with or without an allowlist', () => {
    const none = { maxMiB: 1024, classes: new Map() };
    expect(resolveWorkloadStorage({ size: '1Gi', storageClass: null }, none)).toEqual({
      size: '1Gi',
      access: 'rwo',
    });
    const some = { maxMiB: 1024, classes: parseStorageClasses('fast:rwo,nfs:rwx') };
    expect(resolveWorkloadStorage({ size: '1Gi', storageClass: null }, some)).toEqual({
      size: '1Gi',
      storageClass: 'fast',
      access: 'rwo',
    });
  });
});

'use strict';
// catalog_tools.js — Unity Addressables BinaryStorageBuffer parser.
// Ported from AddressablesToolsPy (anosu/AddressablesToolsPy@7a0c5ff).
// No external dependencies. No URL fields in output.
//
// Header layout (offsets in bytes from file start):
//   [int32  Magic=0x0DE38942][int32  Version]
//   [uint32 KeysOffset][uint32 IdOffset][uint32 InstanceProviderOffset]
//   [uint32 SceneProviderOffset][uint32 InitObjectsArrayOffset]
//   [uint32 BuildResultHashOffset]  ← omitted if Version==1 && KeysOffset==0x20
//
// KeysOffset → read_offset_array → flat pairs [keyOff, locListOff, ...]
// Each pair: decode_v2(keyOff) → key string; read_offset_array(locListOff) → location offsets
// Each location offset → ResourceLocation { primaryKey, internalId, providerId, dependencies[] }
//
// Exports: window.catalogTools = { parse(mainBuf, smallBuf?) }

(function (root) {

const UINT_MAX    = 0xFFFFFFFF;
const UINT_MAX_1  = 0xFFFFFFFE;  // also treated as "no value"

// Type match-names used in decode_v2
const TYPE_STRING  = 'mscorlib; System.String';
const TYPE_INT32   = 'mscorlib; System.Int32';
const TYPE_INT64   = 'mscorlib; System.Int64';
const TYPE_BOOL    = 'mscorlib; System.Boolean';
const TYPE_HASH128 = 'UnityEngine.CoreModule; UnityEngine.Hash128';

function getBundleHash(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/^([0-9a-f]{32})(\.bundle)?$/i);
  return m ? m[1].toLowerCase() : null;
}

// -- Reader --------------------------------------------------------------------

class CatalogReader {
  constructor(buf) {
    this._buf   = buf;
    this._view  = new DataView(buf);
    this._bytes = new Uint8Array(buf);
    this._pos   = 0;
    this.version = 1;
    this._cache  = new Map();
  }

  get size() { return this._buf.byteLength; }
  seek(pos)  { this._pos = pos; }

  readUint8()  { return this._bytes[this._pos++]; }
  readInt32()  { const v = this._view.getInt32(this._pos, true);  this._pos += 4; return v; }
  readUint32() { const v = this._view.getUint32(this._pos, true); this._pos += 4; return v; }
  readChar()   { return String.fromCharCode(this.readUint8()); }

  // seek(offset - 4) → int32 byteSize → [uint32 × byteSize/4]
  // NOTE: offset here is a raw file pointer, NOT bit-encoded like string offsets.
  readOffsetArray(offset) {
    if (offset === UINT_MAX) return [];
    const ck = 'oa' + offset;
    if (this._cache.has(ck)) return this._cache.get(ck);
    const base = offset - 4;
    if (base < 0 || base + 4 > this.size) return [];
    this.seek(base);
    const byteSize = this.readInt32();
    if (byteSize <= 0 || byteSize % 4 !== 0 || this._pos + byteSize > this.size) return [];
    const arr = [];
    for (let i = 0; i < byteSize >> 2; i++) arr.push(this.readUint32());
    this._cache.set(ck, arr);
    return arr;
  }

  readEncodedString(encodedOffset, dynSep = '\0') {
    if (encodedOffset === UINT_MAX || encodedOffset === UINT_MAX_1) return null;
    const ck = 's' + encodedOffset + dynSep;
    if (this._cache.has(ck)) return this._cache.get(ck);
    const unicode = (encodedOffset & 0x80000000) !== 0;
    const dynamic = (encodedOffset & 0x40000000) !== 0 && dynSep !== '\0';
    const offset  = encodedOffset & 0x3FFFFFFF;
    const result  = dynamic ? this._dynStr(offset, dynSep) : this._basicStr(offset, unicode);
    this._cache.set(ck, result);
    return result;
  }

  _basicStr(offset, unicode) {
    const base = offset - 4;
    if (base < 0 || base + 4 > this.size) return '';
    this.seek(base);
    const len = this.readInt32();
    if (len <= 0 || this._pos + len > this.size) return '';
    const data = this._bytes.subarray(this._pos, this._pos + len);
    this._pos += len;
    if (unicode) {
      const u16 = [];
      for (let i = 0; i + 1 < data.length; i += 2)
        u16.push(data[i] | (data[i + 1] << 8));
      return String.fromCharCode(...u16);
    }
    let s = '';
    for (const b of data) s += String.fromCharCode(b);
    return s;
  }

  _dynStr(offset, sep) {
    const parts = [];
    this.seek(offset);
    while (true) {
      const partOff  = this.readUint32();
      const nextOff  = this.readUint32();
      parts.push(this.readEncodedString(partOff));
      if (nextOff === UINT_MAX) break;
      this.seek(nextOff);
    }
    if (parts.length === 1) return parts[0];
    if (this.version > 1) parts.reverse();
    return parts.join(sep);
  }

  cached(key, fn) {
    if (this._cache.has(key)) return this._cache.get(key);
    const v = fn();
    this._cache.set(key, v);
    return v;
  }
}

// -- SerializedType ------------------------------------------------------------

function readSerializedType(reader, offset) {
  if (offset === UINT_MAX || offset === UINT_MAX_1) return null;
  return reader.cached('st' + offset, () => {
    reader.seek(offset);
    const asmOff   = reader.readUint32();
    const classOff = reader.readUint32();
    const asm   = reader.readEncodedString(asmOff, '.');
    const cls   = reader.readEncodedString(classOff, '.');
    const short = (asm && asm.includes(',')) ? asm.split(',')[0] : asm;
    return { matchName: short + '; ' + cls };
  });
}

// -- decode_v2 (key decoder) ---------------------------------------------------

function decodeV2(reader, offset) {
  if (offset === UINT_MAX || offset === UINT_MAX_1) return null;
  return reader.cached('v2' + offset, () => {
    if (offset + 8 > reader.size) return null;
    reader.seek(offset);
    const typeOff   = reader.readUint32();
    const objOff    = reader.readUint32();
    const isDefault = objOff === UINT_MAX;
    const stype     = readSerializedType(reader, typeOff);
    const mn        = stype ? stype.matchName : null;
    switch (mn) {
      case TYPE_STRING: {
        if (isDefault) return null;
        reader.seek(objOff);
        const strOff = reader.readUint32();
        const sep    = reader.readChar();
        return reader.readEncodedString(strOff, sep);
      }
      case TYPE_INT32: {
        if (isDefault) return 0;
        reader.seek(objOff); return reader.readInt32();
      }
      case TYPE_BOOL: {
        if (isDefault) return false;
        reader.seek(objOff); return reader.readUint8() !== 0;
      }
      default:
        return null;  // Hash128, ABRO etc. — not needed for asset mapping
    }
  });
}

// -- ResourceLocation ----------------------------------------------------------

function readResourceLocation(reader, offset) {
  if (offset === UINT_MAX || offset === UINT_MAX_1) return null;
  return reader.cached('rl' + offset, () => {
    if (offset + 28 > reader.size) return null;
    reader.seek(offset);
    const primaryKeyOff   = reader.readUint32();
    const internalIdOff   = reader.readUint32();
    const providerIdOff   = reader.readUint32();
    const dependenciesOff = reader.readUint32();
    /* depHashCode */       reader.readInt32();
    /* dataOffset */        reader.readUint32();
    /* typeOffset */        reader.readUint32();

    const primaryKey = reader.readEncodedString(primaryKeyOff, '/');
    const internalId = reader.readEncodedString(internalIdOff, '/');
    const providerId = reader.readEncodedString(providerIdOff, '.');

    const depOffsets   = reader.readOffsetArray(dependenciesOff);
    const dependencies = depOffsets.map(off => readResourceLocation(reader, off));

    return { primaryKey, internalId, providerId, dependencies };
  });
}

// -- Main parse ----------------------------------------------------------------

function parseSingle(buf, allBundlesSet, bundleAssets, assetToBundle) {
  const reader = new CatalogReader(buf);

  reader.readInt32();  // magic
  const version    = reader.readInt32();
  reader.version   = version;
  const keysOffset = reader.readUint32();

  const keyLocPairs = reader.readOffsetArray(keysOffset);

  function addAsset(hash, name) {
    if (!name || assetToBundle[name]) return;
    if (!bundleAssets[hash]) bundleAssets[hash] = new Set();
    bundleAssets[hash].add(name);
    assetToBundle[name] = hash;
  }

  for (let i = 0; i + 1 < keyLocPairs.length; i += 2) {
    const key             = decodeV2(reader, keyLocPairs[i]);
    const locationOffsets = reader.readOffsetArray(keyLocPairs[i + 1]);

    for (const locOff of locationOffsets) {
      const loc = readResourceLocation(reader, locOff);
      if (!loc) continue;

      // Bundle entry: primaryKey = "32hex.bundle"
      const selfHash = getBundleHash(loc.primaryKey);
      if (selfHash) {
        allBundlesSet.add(selfHash);
        if (!bundleAssets[selfHash]) bundleAssets[selfHash] = new Set();
        continue;
      }

      // Asset entry: has a bundle in its dependency list
      for (const dep of loc.dependencies) {
        if (!dep) continue;
        const depHash = getBundleHash(dep.primaryKey);
        if (!depHash) continue;
        allBundlesSet.add(depHash);
        if (!bundleAssets[depHash]) bundleAssets[depHash] = new Set();

        const sources = [];
        if (loc.internalId) sources.push(loc.internalId);
        if (typeof key === 'string') sources.push(key);

        for (const src of sources) {
          const filename = src.includes('/') ? src.split('/').pop() : src;
          if (!filename) continue;
          addAsset(depHash, filename);
          // Also add bare name (no extension) so audio like "bgm_0060" resolves
          const bare = filename.replace(/\.[^.]+$/, '');
          if (bare !== filename) addAsset(depHash, bare);
        }
        break;
      }
    }
  }
}

function parse(mainBuf) {
  const allBundlesSet = new Set();
  const bundleAssets  = {};   // hash32 → Set of asset names
  const assetToBundle = {};   // name → hash32

  parseSingle(mainBuf, allBundlesSet, bundleAssets, assetToBundle);

  const bundles = [...allBundlesSet].sort();
  const assets  = Object.fromEntries(
    Object.entries(assetToBundle).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  );

  const result = { bundles, assets };
  root.__catalog = result;
  return result;
}

root.catalogTools = { parse };

}(typeof window !== 'undefined' ? window : global));

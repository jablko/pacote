const Fetcher = require('./fetcher.js')
const RemoteFetcher = require('./remote.js')
const _tarballFromResolved = Symbol.for('pacote.Fetcher._tarballFromResolved')
const pacoteVersion = require('../package.json').version
const removeTrailingSlashes = require('./util/trailing-slashes.js')
const npa = require('npm-package-arg')
const rpj = require('read-package-json-fast')
const pickManifest = require('npm-pick-manifest')
const ssri = require('ssri')
const crypto = require('crypto')

// Corgis are cute. 🐕🐶
const corgiDoc = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'
const fullDoc = 'application/json'

const fetch = require('npm-registry-fetch')

const _headers = Symbol('_headers')
class RegistryFetcher extends Fetcher {
  constructor (spec, opts) {
    super(spec, opts)

    // you usually don't want to fetch the same packument multiple times in
    // the span of a given script or command, no matter how many pacote calls
    // are made, so this lets us avoid doing that.  It's only relevant for
    // registry fetchers, because other types simulate their packument from
    // the manifest, which they memoize on this.package, so it's very cheap
    // already.
    this.packumentCache = this.opts.packumentCache || null

    // handle case when npm-package-arg guesses wrong.
    if (this.spec.type === 'tag' &&
        this.spec.rawSpec === '' &&
        this.defaultTag !== 'latest') {
      this.spec = npa(`${this.spec.name}@${this.defaultTag}`)
    }
    this.registry = fetch.pickRegistry(spec, opts)
    this.packumentUrl = removeTrailingSlashes(this.registry) + '/' +
      this.spec.escapedName

    const parsed = new URL(this.registry)
    const regKey = `//${parsed.host}${parsed.pathname}`
    // unlike the nerf-darted auth keys, this one does *not* allow a mismatch
    // of trailing slashes.  It must match exactly.
    if (this.opts[`${regKey}:_keys`]) {
      this.registryKeys = this.opts[`${regKey}:_keys`]
    }

    // XXX pacote <=9 has some logic to ignore opts.resolved if
    // the resolved URL doesn't go to the same registry.
    // Consider reproducing that here, to throw away this.resolved
    // in that case.
  }

  async resolve () {
    // fetching the manifest sets resolved and (if present) integrity
    await this.manifest()
    if (!this.resolved) {
      throw Object.assign(
        new Error('Invalid package manifest: no `dist.tarball` field'),
        { package: this.spec.toString() }
      )
    }
    return this.resolved
  }

  [_headers] () {
    return {
      // npm will override UA, but ensure that we always send *something*
      'user-agent': this.opts.userAgent ||
        `pacote/${pacoteVersion} node/${process.version}`,
      ...(this.opts.headers || {}),
      'pacote-version': pacoteVersion,
      'pacote-req-type': 'packument',
      'pacote-pkg-id': `registry:${this.spec.name}`,
      accept: this.fullMetadata ? fullDoc : corgiDoc,
    }
  }

  async packument () {
    // note this might be either an in-flight promise for a request,
    // or the actual packument, but we never want to make more than
    // one request at a time for the same thing regardless.
    if (this.packumentCache && this.packumentCache.has(this.packumentUrl)) {
      return this.packumentCache.get(this.packumentUrl)
    }

    // npm-registry-fetch the packument
    // set the appropriate header for corgis if fullMetadata isn't set
    // return the res.json() promise
    try {
      const res = await fetch(this.packumentUrl, {
        ...this.opts,
        headers: this[_headers](),
        spec: this.spec,
        // never check integrity for packuments themselves
        integrity: null,
      })
      const packument = await res.json()
      packument._cached = res.headers.has('x-local-cache')
      packument._contentLength = +res.headers.get('content-length')
      if (this.packumentCache) {
        this.packumentCache.set(this.packumentUrl, packument)
      }
      return packument
    } catch (err) {
      if (this.packumentCache) {
        this.packumentCache.delete(this.packumentUrl)
      }
      if (err.code !== 'E404' || this.fullMetadata) {
        throw err
      }
      // possible that corgis are not supported by this registry
      this.fullMetadata = true
      return this.packument()
    }
  }

  async manifest () {
    if (this.package) {
      return this.package
    }

    const packument = await this.packument()
    const mani = await pickManifest(packument, this.spec.fetchSpec, {
      ...this.opts,
      defaultTag: this.defaultTag,
      before: this.before,
    })
    /* XXX add ETARGET and E403 revalidation of cached packuments here */

    // add _resolved and _integrity from dist object
    const { dist } = mani
    if (dist) {
      this.resolved = mani._resolved = dist.tarball
      mani._from = this.from
      const distIntegrity = dist.integrity ? ssri.parse(dist.integrity)
        : dist.shasum ? ssri.fromHex(dist.shasum, 'sha1', { ...this.opts })
        : null
      if (distIntegrity) {
        if (this.integrity && !this.integrity.match(distIntegrity)) {
          // only bork if they have algos in common.
          // otherwise we end up breaking if we have saved a sha512
          // previously for the tarball, but the manifest only
          // provides a sha1, which is possible for older publishes.
          // Otherwise, this is almost certainly a case of holding it
          // wrong, and will result in weird or insecure behavior
          // later on when building package tree.
          for (const algo of Object.keys(this.integrity)) {
            if (distIntegrity[algo]) {
              throw Object.assign(new Error(
                `Integrity checksum failed when using ${algo}: ` +
                `wanted ${this.integrity} but got ${distIntegrity}.`
              ), { code: 'EINTEGRITY' })
            }
          }
        }
        // made it this far, the integrity is worthwhile.  accept it.
        // the setter here will take care of merging it into what we already
        // had.
        this.integrity = distIntegrity
      }
    }
    if (this.integrity) {
      mani._integrity = String(this.integrity)
      if (dist.signatures) {
        if (this.opts.verifySignatures) {
          if (this.registryKeys) {
            // validate and throw on error, then set _signatures
            const message = `${mani._id}:${mani._integrity}`
            for (const signature of dist.signatures) {
              const publicKey = this.registryKeys.filter(key => (key.keyid === signature.keyid))[0]
              if (!publicKey) {
                throw Object.assign(new Error(
                  `${mani._id} has a signature with keyid: ${signature.keyid} ` +
                  'but no corresponding public key can be found.'
                ), { code: 'EMISSINGSIGNATUREKEY' })
              }
              const validPublicKey =
                !publicKey.expires || (Date.parse(publicKey.expires) > Date.now())
              if (!validPublicKey) {
                throw Object.assign(new Error(
                  `${mani._id} has a signature with keyid: ${signature.keyid} ` +
                  `but the corresponding public key has expired ${publicKey.expires}`
                ), { code: 'EEXPIREDSIGNATUREKEY' })
              }
              const verifier = crypto.createVerify('SHA256')
              verifier.write(message)
              verifier.end()
              const valid = verifier.verify(
                publicKey.pemkey,
                signature.sig,
                'base64'
              )
              if (!valid) {
                throw Object.assign(new Error(
                  'Integrity checksum signature failed: ' +
                  `key ${publicKey.keyid} signature ${signature.sig}`
                ), { code: 'EINTEGRITYSIGNATURE' })
              }
            }
            mani._signatures = dist.signatures
          }
          // if no keys, don't set _signatures
        } else {
          mani._signatures = dist.signatures
        }
      }
    }
    this.package = rpj.normalize(mani)
    return this.package
  }

  [_tarballFromResolved] () {
    // we use a RemoteFetcher to get the actual tarball stream
    return new RemoteFetcher(this.resolved, {
      ...this.opts,
      resolved: this.resolved,
      pkgid: `registry:${this.spec.name}@${this.resolved}`,
    })[_tarballFromResolved]()
  }

  get types () {
    return [
      'tag',
      'version',
      'range',
    ]
  }
}
module.exports = RegistryFetcher

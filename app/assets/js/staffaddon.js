'use strict'

const { app, safeStorage } = require('electron')
const crypto = require('crypto')
const fs = require('fs-extra')
const got = require('got')
const path = require('path')
const { pipeline } = require('stream/promises')
const { Transform } = require('stream')
const { HeliosModule } = require('helios-core/common')

const TOKEN_FILE = () => path.join(app.getPath('userData'), 'staff-access.bin')
const TYPES = new Set(['ForgeMod', 'FabricMod', 'LiteMod'])

function apiRoot(value){
    const url = new URL(value)
    if(!['http:', 'https:'].includes(url.protocol)) throw new Error('The staff API address must use HTTP or HTTPS.')
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`
}

function readToken(){
    if(!fs.existsSync(TOKEN_FILE())) return null
    if(!safeStorage.isEncryptionAvailable()) throw new Error('Secure token storage is unavailable on this device.')
    return safeStorage.decryptString(fs.readFileSync(TOKEN_FILE()))
}

function writeToken(token){
    if(!safeStorage.isEncryptionAvailable()) throw new Error('Secure token storage is unavailable on this device.')
    fs.writeFileSync(TOKEN_FILE(), safeStorage.encryptString(token), { mode: 0o600 })
}

async function redeem(apiUrl, code){
    const root = apiRoot(apiUrl)
    const response = await got.post(`${root}/redeem`, { json: { code }, responseType: 'json', followRedirect: false, timeout: { request: 15000 } })
    if(typeof response.body.token !== 'string') throw new Error('The server returned an invalid access token.')
    writeToken(response.body.token)
    return { ok: true }
}

async function forget(apiUrl){
    const token = readToken()
    if(token && apiUrl){
        try { await got.post(`${apiRoot(apiUrl)}/revoke-self`, { headers: { authorization: `Bearer ${token}` }, followRedirect: false, timeout: { request: 8000 } }) }
        catch(_err) { /* Forget local access even while offline. */ }
    }
    await fs.remove(TOKEN_FILE())
    return { ok: true }
}

async function getManifest(apiUrl, serverId){
    const token = readToken()
    if(!token) return { modules: [], authorized: false }
    try {
        const response = await got.get(`${apiRoot(apiUrl)}/manifest`, {
            searchParams: { serverId }, headers: { authorization: `Bearer ${token}` }, responseType: 'json', followRedirect: false, timeout: { request: 20000 }
        })
        if(response.body.serverId !== serverId || !Array.isArray(response.body.modules)) throw new Error('Invalid staff addon manifest.')
        return response.body
    } catch(err) {
        if(err.response?.statusCode === 401) await fs.remove(TOKEN_FILE())
        throw err
    }
}

async function hashFile(file){
    const md5 = crypto.createHash('md5')
    const sha = crypto.createHash('sha256')
    let size = 0
    for await (const chunk of fs.createReadStream(file)){
        size += chunk.length
        md5.update(chunk)
        sha.update(chunk)
    }
    return { size, md5: md5.digest('hex'), sha256: sha.digest('hex') }
}

async function prepare(apiUrl, serverId, commonDir, instanceDir){
    const root = apiRoot(apiUrl)
    const manifest = await getManifest(root, serverId)
    const rawModules = []
    const seen = new Set()
    for(const mod of manifest.modules){
        if(!mod || typeof mod.id !== 'string' || !/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.+-]+(?:@[A-Za-z0-9_.-]+)?$/.test(mod.id)
            || typeof mod.name !== 'string' || mod.name.length < 1 || mod.name.length > 120 || seen.has(mod.id) || !TYPES.has(mod.type)
            || !/^[A-Za-z0-9_.-]+$/.test(mod.fileId || '') || !Number.isSafeInteger(mod.size)
            || !/^[a-f0-9]{32}$/i.test(mod.md5 || '') || !/^[a-f0-9]{64}$/i.test(mod.sha256 || '')){
            throw new Error('The staff addon manifest contains invalid module data.')
        }
        seen.add(mod.id)
        const raw = { id: mod.id, name: mod.name, type: mod.type, required: { value: true, def: true }, artifact: { size: mod.size, MD5: mod.md5, url: `${root}/files/${encodeURIComponent(mod.fileId)}?serverId=${encodeURIComponent(serverId)}` } }
        const module = new HeliosModule(raw, serverId, commonDir, instanceDir)
        const target = module.localPath
        await fs.ensureDir(path.dirname(target))
        let valid = false
        if(await fs.pathExists(target)){
            const actual = await hashFile(target)
            valid = actual.size === mod.size && actual.md5.toLowerCase() === mod.md5.toLowerCase() && actual.sha256 === mod.sha256
        }
        if(!valid){
            const temp = `${target}.${process.pid}.staff-download`
            const token = readToken()
            const md5 = crypto.createHash('md5')
            const sha = crypto.createHash('sha256')
            let size = 0
            try {
                await pipeline(got.stream(raw.artifact.url, { headers: { authorization: `Bearer ${token}` }, followRedirect: false, timeout: { request: 60000 } }), new Transform({ transform(chunk, _encoding, callback){ size += chunk.length; md5.update(chunk); sha.update(chunk); callback(null, chunk) } }), fs.createWriteStream(temp, { mode: 0o600 }))
                if(size !== mod.size || md5.digest('hex').toLowerCase() !== mod.md5.toLowerCase() || sha.digest('hex') !== mod.sha256) throw new Error(`Staff addon integrity check failed for ${mod.name}.`)
                await fs.move(temp, target, { overwrite: true })
            } catch(err) {
                await fs.remove(temp)
                throw err
            }
        }
        rawModules.push(raw)
    }
    return rawModules
}

module.exports = { redeem, forget, getManifest, prepare }

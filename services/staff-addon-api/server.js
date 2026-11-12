'use strict'

const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { pipeline } = require('stream')
const { promisify } = require('util')

const pipelineAsync = promisify(pipeline)
const DATA_DIR = path.resolve(process.env.STAFF_API_DATA_DIR || path.join(__dirname, 'private-data'))
const FILES_DIR = path.resolve(process.env.STAFF_API_FILES_DIR || path.join(__dirname, 'private-files'))
const MANIFEST_PATH = path.resolve(process.env.STAFF_API_MANIFEST_PATH || path.join(__dirname, 'manifest.json'))
const HOST = process.env.STAFF_API_HOST || '127.0.0.1'
const PORT = Number.parseInt(process.env.STAFF_API_PORT || '8091', 10)
const CODES_PATH = path.join(DATA_DIR, 'codes.json')
const TOKENS_PATH = path.join(DATA_DIR, 'tokens.json')
const ALLOWED_MODULE_TYPES = new Set(['ForgeMod', 'FabricMod', 'LiteMod'])
const SAFE_ID = /^[A-Za-z0-9_.-]+$/
const SAFE_MAVEN_ID = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.+-]+(?:@[A-Za-z0-9_.-]+)?$/
const redeemAttempts = new Map()

function ensureStorage(){
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    fs.mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 })
    for(const file of [CODES_PATH, TOKENS_PATH]){
        if(!fs.existsSync(file)){
            writeJsonAtomic(file, [])
        }
    }
    if(!fs.existsSync(MANIFEST_PATH)){
        writeJsonAtomic(MANIFEST_PATH, { version: 1, servers: {} })
    }
}

function readJson(file){
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJsonAtomic(file, value){
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, file)
}

function sha256(value){
    return crypto.createHash('sha256').update(value).digest('hex')
}

function hashFile(file){
    const md5 = crypto.createHash('md5')
    const sha = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    return new Promise((resolve, reject) => {
        stream.on('data', chunk => {
            md5.update(chunk)
            sha.update(chunk)
        })
        stream.on('error', reject)
        stream.on('end', () => resolve({
            size: fs.statSync(file).size,
            md5: md5.digest('hex'),
            sha256: sha.digest('hex')
        }))
    })
}

function normalizeCode(code){
    return typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : ''
}

function validateManifest(manifest){
    if(!manifest || manifest.version !== 1 || !manifest.servers || typeof manifest.servers !== 'object'){
        throw new Error('Manifest must contain version 1 and a servers object.')
    }
    for(const [serverId, server] of Object.entries(manifest.servers)){
        if(!SAFE_ID.test(serverId) || !server || !Array.isArray(server.modules)){
            throw new Error(`Invalid staff addon server entry: ${serverId}`)
        }
        const ids = new Set()
        for(const mod of server.modules){
            validateModule(mod)
            if(ids.has(mod.id)){
                throw new Error(`Duplicate module id in ${serverId}: ${mod.id}`)
            }
            ids.add(mod.id)
        }
    }
}

function validateModule(mod){
    if(!mod || typeof mod !== 'object'
        || typeof mod.id !== 'string' || !SAFE_MAVEN_ID.test(mod.id)
        || typeof mod.name !== 'string' || mod.name.length < 1 || mod.name.length > 120
        || !ALLOWED_MODULE_TYPES.has(mod.type)
        || typeof mod.fileId !== 'string' || !SAFE_ID.test(mod.fileId)
        || !Number.isSafeInteger(mod.size) || mod.size < 1
        || !/^[a-f0-9]{32}$/i.test(mod.md5 || '')
        || !/^[a-f0-9]{64}$/i.test(mod.sha256 || '')){
        throw new Error(`Invalid staff addon module: ${mod?.id || '(unnamed)'}`)
    }
}

function getServerModules(serverId){
    if(typeof serverId !== 'string' || !SAFE_ID.test(serverId)){
        return null
    }
    const manifest = readJson(MANIFEST_PATH)
    validateManifest(manifest)
    return manifest.servers[serverId]?.modules || []
}

function bearerToken(req){
    const header = req.headers.authorization || ''
    const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(header)
    return match ? match[1] : null
}

function authenticate(req){
    const token = bearerToken(req)
    if(!token){
        return null
    }
    const tokenHash = sha256(token)
    const record = readJson(TOKENS_PATH).find(item => item.hash === tokenHash && item.active)
    return record || null
}

function json(res, status, value){
    const body = Buffer.from(JSON.stringify(value))
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    })
    res.end(body)
}

async function readRequestJson(req, maxBytes = 4096){
    const chunks = []
    let length = 0
    for await (const chunk of req){
        length += chunk.length
        if(length > maxBytes){
            const err = new Error('Request body too large.')
            err.statusCode = 413
            throw err
        }
        chunks.push(chunk)
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch(_err) {
        const err = new Error('Invalid JSON body.')
        err.statusCode = 400
        throw err
    }
}

function mayRedeem(req){
    const forwarded = req.headers['x-forwarded-for']
    const address = typeof forwarded === 'string'
        ? forwarded.split(',')[0].trim()
        : req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    const current = redeemAttempts.get(address)
    if(!current || now >= current.resetAt){
        redeemAttempts.set(address, { count: 1, resetAt: now + 60_000 })
        return true
    }
    current.count++
    return current.count <= 12
}

async function handleRequest(req, res){
    const requestUrl = new URL(req.url, 'http://localhost')
    const method = req.method || 'GET'

    if(method === 'GET' && requestUrl.pathname === '/health'){
        return json(res, 200, { status: 'ok' })
    }

    if(method === 'POST' && requestUrl.pathname === '/v1/redeem'){
        if(!mayRedeem(req)){
            return json(res, 429, { error: 'Too many code attempts. Try again later.' })
        }
        const body = await readRequestJson(req)
        const normalized = normalizeCode(body.code)
        if(normalized.length < 20 || normalized.length > 100){
            return json(res, 401, { error: 'Invalid or already used code.' })
        }
        const codeHash = sha256(normalized)
        const codes = readJson(CODES_PATH)
        const code = codes.find(item => item.hash === codeHash && !item.usedAt)
        if(!code){
            return json(res, 401, { error: 'Invalid or already used code.' })
        }

        const token = crypto.randomBytes(32).toString('base64url')
        const tokenId = crypto.randomUUID()
        const tokens = readJson(TOKENS_PATH)
        tokens.push({ id: tokenId, hash: sha256(token), active: true, createdAt: new Date().toISOString() })
        code.usedAt = new Date().toISOString()
        code.tokenId = tokenId
        writeJsonAtomic(TOKENS_PATH, tokens)
        writeJsonAtomic(CODES_PATH, codes)
        return json(res, 201, { token, tokenId })
    }

    const auth = authenticate(req)
    if(!auth){
        return json(res, 401, { error: 'Staff access is missing or revoked.' })
    }

    if(method === 'GET' && requestUrl.pathname === '/v1/manifest'){
        const serverId = requestUrl.searchParams.get('serverId')
        const modules = getServerModules(serverId)
        if(modules == null){
            return json(res, 404, { error: 'No staff addon is configured for this server.' })
        }
        for(const mod of modules){
            const filePath = path.join(FILES_DIR, `${mod.fileId}.jar`)
            const stat = fs.statSync(filePath)
            if(!stat.isFile() || stat.size !== mod.size){
                return json(res, 503, { error: `Staff addon asset is missing or changed: ${mod.name}` })
            }
        }
        return json(res, 200, { version: 1, serverId, authorized: true, modules })
    }

    const fileMatch = /^\/v1\/files\/([A-Za-z0-9_.-]+)$/.exec(requestUrl.pathname)
    if(method === 'GET' && fileMatch){
        const serverId = requestUrl.searchParams.get('serverId')
        const fileId = fileMatch[1]
        const modules = getServerModules(serverId)
        const mod = modules?.find(item => item.fileId === fileId)
        if(!mod){
            return json(res, 404, { error: 'Staff addon asset not found.' })
        }
        const filePath = path.join(FILES_DIR, `${fileId}.jar`)
        const stat = fs.statSync(filePath)
        if(!stat.isFile() || stat.size !== mod.size){
            return json(res, 503, { error: 'Staff addon asset is unavailable.' })
        }
        res.writeHead(200, {
            'Content-Type': 'application/java-archive',
            'Content-Length': stat.size,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff'
        })
        await pipelineAsync(fs.createReadStream(filePath), res)
        return
    }

    if(method === 'POST' && requestUrl.pathname === '/v1/revoke-self'){
        const tokens = readJson(TOKENS_PATH)
        const token = tokens.find(item => item.id === auth.id)
        if(token){
            token.active = false
            token.revokedAt = new Date().toISOString()
            writeJsonAtomic(TOKENS_PATH, tokens)
        }
        return json(res, 200, { revoked: true })
    }

    return json(res, 404, { error: 'Not found.' })
}

async function addModule(serverId, id, name, type, sourcePath){
    if(!SAFE_ID.test(serverId) || !SAFE_MAVEN_ID.test(id) || !ALLOWED_MODULE_TYPES.has(type)){
        throw new Error('Invalid server id, Maven id, or module type.')
    }
    const resolvedSource = path.resolve(sourcePath)
    if(path.extname(resolvedSource).toLowerCase() !== '.jar' || !fs.statSync(resolvedSource).isFile()){
        throw new Error('Source must be a .jar file.')
    }
    const fileId = crypto.randomBytes(16).toString('hex')
    const targetPath = path.join(FILES_DIR, `${fileId}.jar`)
    fs.copyFileSync(resolvedSource, targetPath, fs.constants.COPYFILE_EXCL)
    const hashes = await hashFile(targetPath)
    const manifest = readJson(MANIFEST_PATH)
    validateManifest(manifest)
    const server = manifest.servers[serverId] || (manifest.servers[serverId] = { modules: [] })
    const replaced = server.modules.filter(mod => mod.id === id)
    const previous = server.modules.filter(mod => mod.id !== id)
    server.modules = [...previous, { id, name, type, fileId, ...hashes }]
    validateManifest(manifest)
    writeJsonAtomic(MANIFEST_PATH, manifest)
    const referenced = new Set(Object.values(manifest.servers).flatMap(entry => entry.modules.map(mod => mod.fileId)))
    for(const old of replaced){
        if(!referenced.has(old.fileId)){
            const oldPath = path.join(FILES_DIR, `${old.fileId}.jar`)
            if(fs.existsSync(oldPath)) fs.rmSync(oldPath)
        }
    }
    console.log(`Added ${name} (${id}) to staff addon for ${serverId}.`)
    console.log(`Private file id: ${fileId}`)
}

function removeModule(serverId, id){
    const manifest = readJson(MANIFEST_PATH)
    validateManifest(manifest)
    const server = manifest.servers[serverId]
    if(!server){
        throw new Error(`Unknown server: ${serverId}`)
    }
    const removed = server.modules.filter(mod => mod.id === id)
    server.modules = server.modules.filter(mod => mod.id !== id)
    if(removed.length === 0){
        throw new Error(`Unknown staff module: ${id}`)
    }
    writeJsonAtomic(MANIFEST_PATH, manifest)
    const referenced = new Set(Object.values(manifest.servers).flatMap(entry => entry.modules.map(mod => mod.fileId)))
    for(const mod of removed){
        if(!referenced.has(mod.fileId)){
            const filePath = path.join(FILES_DIR, `${mod.fileId}.jar`)
            if(fs.existsSync(filePath)) fs.rmSync(filePath)
        }
    }
    console.log(`Removed ${id} from staff addon for ${serverId}.`)
}

async function runCli(){
    ensureStorage()
    const [command, ...args] = process.argv.slice(2)
    if(command === 'create-code'){
        const label = args.join(' ').trim() || 'staff member'
        const code = `PDST-${crypto.randomBytes(16).toString('hex').toUpperCase()}`
        const codes = readJson(CODES_PATH)
        codes.push({ hash: sha256(normalizeCode(code)), label, createdAt: new Date().toISOString() })
        writeJsonAtomic(CODES_PATH, codes)
        console.log(`One-time code for ${label}:\n${code}`)
        console.log('Copy it now; the plaintext code is not stored.')
    } else if(command === 'list-tokens'){
        for(const token of readJson(TOKENS_PATH)){
            console.log(`${token.active ? 'active' : 'revoked'}\t${token.id}\t${token.createdAt}`)
        }
    } else if(command === 'revoke-token'){
        const tokenId = args[0]
        const tokens = readJson(TOKENS_PATH)
        const token = tokens.find(item => item.id === tokenId)
        if(!token) throw new Error(`Unknown token id: ${tokenId}`)
        token.active = false
        token.revokedAt = new Date().toISOString()
        writeJsonAtomic(TOKENS_PATH, tokens)
        console.log(`Revoked staff token ${tokenId}.`)
    } else if(command === 'add-mod'){
        if(args.length < 5) throw new Error('Usage: add-mod <serverId> <mavenId> <name> <ForgeMod|FabricMod|LiteMod> <jarPath>')
        await addModule(args[0], args[1], args[2], args[3], args.slice(4).join(' '))
    } else if(command === 'remove-mod'){
        if(args.length < 2) throw new Error('Usage: remove-mod <serverId> <mavenId>')
        removeModule(args[0], args[1])
    } else {
        console.log('Commands: create-code [label], list-tokens, revoke-token <tokenId>, add-mod <serverId> <mavenId> <name> <type> <jarPath>, remove-mod <serverId> <mavenId>')
        process.exitCode = 2
    }
}

async function runServer(){
    ensureStorage()
    const server = http.createServer((req, res) => {
        handleRequest(req, res).catch(err => {
            if(!res.headersSent){
                json(res, err.statusCode || 500, { error: err.statusCode ? err.message : 'Staff addon service error.' })
            } else {
                res.destroy(err)
            }
            if(!err.statusCode){
                console.error(err)
            }
        })
    })
    server.listen(PORT, HOST, () => {
        console.log(`Staff addon API listening on http://${HOST}:${PORT}`)
    })
}

if(require.main === module){
    const command = process.argv[2]
    const operation = command ? runCli() : runServer()
    operation.catch(err => {
        console.error(err.message)
        process.exitCode = 1
    })
}

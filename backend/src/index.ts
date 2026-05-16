import { Hono } from 'hono'
import { cors } from 'hono/cors'
import fs from 'fs'
import { createServer } from 'node:http'
import { CONT } from './consts'
import { logger } from './utils'
import { RCEActionHandler } from './rce'
import { actions } from './functions'
import { PermissionLevel } from './types/rce'
import { ADAPT } from './adaptive'
import {
  normalizeConfig,
  readConfig,
  validateIncomingConfig,
  writeConfig,
  type ActionConfig,
} from './config/permissions'
import { CHANGELOG_PATH, CONFIG_PATH } from './config/paths'

const SOCKET_PATH = '/run/guest-services/backend.sock';

if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);

// Use loose typing to avoid Hono TS overload friction on route definitions
const app = new Hono()

// Enable CORS for Docker Desktop extension
app.use('/*', cors())

// Log every HTTP request so we can confirm UI->backend calls.
app.use('*', async (c, next) => {
  const started = Date.now()
  const method = c.req.method
  const path = c.req.path || new URL(c.req.url).pathname
  logger.info(`[http] ${method} ${path}`)
  try {
    await next()
  } finally {
    const status = c.res?.status ?? 'unknown'
    const ms = Date.now() - started
    logger.info(`[http] ${method} ${path} -> ${status} (${ms}ms)`)
  }
})

// NOTE: config read/write/normalize/validation lives in ./config/permissions now

function registerActionSubset(actionSubset: typeof actions): void {
  if (!actionSubset.length) return
  const actionsToRegister = actionSubset.map(a => ({
    name: a.name,
    description: a.description,
    schema: a.schema
  }))
  CONT.neuro.registerActions(actionsToRegister)
}

function applyConfigFull(config: ActionConfig): void {
  const enabledActions = actions.filter(action => {
    const permission = config[action.name] ?? action.defaultPermission ?? PermissionLevel.OFF
    return permission !== PermissionLevel.OFF
  })
  const disabledActions = actions.filter(action => {
    const permission = config[action.name] ?? action.defaultPermission ?? PermissionLevel.OFF
    return permission === PermissionLevel.OFF
  })
  logger.info(`Applying config (full): ${enabledActions.length} enabled, ${disabledActions.length} disabled`)

  // Safe baseline: remove everything we know about, then add back enabled.
  CONT.neuro.unregisterActions(actions.map(a => a.name))
  registerActionSubset(enabledActions)

  if (enabledActions.length > 0) {
    logger.info(`Registered ${enabledActions.length} actions: ${enabledActions.map(a => a.name).join(', ')}`)
  }
}

function applyConfigDelta(previous: ActionConfig, next: ActionConfig): void {
  const toUnregister: string[] = []
  const toRegister = [] as typeof actions

  for (const action of actions) {
    const before = previous[action.name] ?? action.defaultPermission ?? PermissionLevel.OFF
    const after = next[action.name] ?? action.defaultPermission ?? PermissionLevel.OFF
    if (before === after) continue

    if (after !== PermissionLevel.OFF) {
      toRegister.push(action)
    } else {
      toUnregister.push(action.name)
    }
  }

  logger.info(
    `Applying config (delta): +${toRegister.length} enabled, -${toUnregister.length} disabled`
  )

  if (toUnregister.length) {
    CONT.neuro.unregisterActions(toUnregister)
    logger.info(`Unregistered actions: ${toUnregister.join(', ')}`)
  }
  if (toRegister.length) {
    registerActionSubset(toRegister)
    logger.info(`Registered actions: ${toRegister.map(a => a.name).join(', ')}`)
  }
}

let currentConfig: ActionConfig = normalizeConfig(actions, undefined)

const GAME_NAME = 'neurontainer'

// Minimal HTTP server for configuration UI
app.get('/', (c) => {
  return c.json({
    status: 'running',
    neuro_connected: CONT.neuro?.ws?.readyState === 1,
    game_name: GAME_NAME
  })
})

app.get('/api/status', (c) => {
  return c.json({
    docker: CONT.docker ? 'connected' : 'disconnected',
    neuro: CONT.neuro?.ws?.readyState === 1 ? 'connected' : 'disconnected',
    neuro_connected_flag: CONT.neuroConnected,
    neuro_server: CONT.currentNeuroUrl,
    neuro_ws: CONT.neuro?.ws ? `ws[url=${CONT.neuro.ws.url ?? 'unknown'}, readyState=${CONT.neuro.ws.readyState}]` : 'ws: none',
    last_neuro_event: CONT.lastNeuroEvent,
    last_reconnect_request: CONT.lastReconnectRequest,
    docker_host: process.env.DOCKER_HOST || 'unset',
    docker_socket_exists: CONT.docker ? true : false,
    adaptive_phase: ADAPT.getStatus().controls.phase,
    adaptive_coherence: ADAPT.getStatus().gauge.coherence
  })
});

app.get('/api/adaptive/status', (c) => {
  return c.json({
    success: true,
    status: ADAPT.getStatus(),
  })
})

app.put('/api/adaptive/controls', async (c) => {
  try {
    const body = await c.req.json()
    const controls = ADAPT.updateControls(body?.controls ?? {})
    return c.json({ success: true, controls })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update adaptive controls'
    logger.error('Error updating adaptive controls:', error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/api/adaptive/checkpoint', async (c) => {
  try {
    const body = await c.req.json()
    const checkpoint = ADAPT.createCheckpoint(body?.label)
    return c.json({ success: true, checkpoint })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create adaptive checkpoint'
    logger.error('Error creating adaptive checkpoint:', error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/api/adaptive/rollback', async (c) => {
  try {
    const body = await c.req.json()
    const checkpointId = body?.checkpointId
    if (!checkpointId || typeof checkpointId !== 'string') {
      return c.json({ success: false, error: 'checkpointId is required' }, 400)
    }
    const rolledBack = ADAPT.rollback(checkpointId)
    if (!rolledBack) {
      return c.json({ success: false, error: `Checkpoint not found: ${checkpointId}` }, 404)
    }
    return c.json({ success: true, status: ADAPT.getStatus() })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to rollback adaptive checkpoint'
    logger.error('Error rolling back adaptive checkpoint:', error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.get('/api/ping', (c) => {
  return c.json({
    success: true,
    message: 'pong'
  })
})

app.get('/api/changelog', async (c) => {
  try {
    const markdown = await fs.promises.readFile(CHANGELOG_PATH, 'utf-8')
    return c.json({ success: true, markdown })
  } catch (error: any) {
    const code = error?.code
    const message = error instanceof Error ? error.message : String(error ?? 'Failed to read changelog')
    logger.error('Error reading changelog:', error)
    if (code === 'ENOENT') {
      return c.json({ success: false, error: `Changelog not found at ${CHANGELOG_PATH}` }, 404)
    }
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/api/reconnect/neuro', async (c) => {
  try {
    const body = await c.req.json()
    const requested = (body.websocketUrl || CONT.currentNeuroUrl) as string
    const { normalized: websocketUrl, note } = CONT.normalizeNeuroUrl(requested)
    CONT.lastReconnectRequest = { requested, normalized: websocketUrl, note, at: Date.now() }
    CONT.lastNeuroEvent = { type: 'reconnect_request', at: Date.now(), requested, normalized: websocketUrl, note }

    console.log(`Reconnect requested. url=${requested}`)
    if (note) console.warn(note)
    console.log(`Reconnecting NeuroClient with URL: ${websocketUrl}`)

    await CONT.reconnectNeuro(websocketUrl)
    const wsInfo = CONT.neuro?.ws ? `ws[url=${CONT.neuro.ws.url ?? 'unknown'}, readyState=${CONT.neuro.ws.readyState}]` : 'ws: none'
    console.log(`Neuro connection confirmed: ${wsInfo}`)
    CONT.lastNeuroEvent = { type: 'reconnect_success', at: Date.now(), url: CONT.currentNeuroUrl, ws: wsInfo }

    return c.json({
      success: true,
      message: `NeuroClient connected to ${CONT.currentNeuroUrl}`,
      websocketUrl: CONT.currentNeuroUrl
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reconnect NeuroClient'
    console.error('Error reconnecting NeuroClient:', error)
    if (CONT.lastReconnectRequest) {
      CONT.lastNeuroEvent = {
        type: 'reconnect_fail',
        at: Date.now(),
        requested: CONT.lastReconnectRequest.requested,
        normalized: CONT.lastReconnectRequest.normalized,
        error: message
      }
    }
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/api/reconnect/docker', async (c) => {
  try {
    logger.info('Docker reconnect requested')
    const result = await CONT.reloadDockerClient()
    if (result) {
      logger.info('Docker client reconnected successfully')

      return c.json({
        success: true,
        message: 'Docker client reconnected successfully',
        dockerHost: process.env.DOCKER_HOST || 'unset'
      })
    } else {
      logger.error('Docker client reconnection unsuccessful')

      return c.json({
        success: false,
        message: 'Docker client reconnection unsuccessful',
        dockerHost: process.env.DOCKER_HOST || 'unset'
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reconnect Docker client'
    logger.error('Error reconnecting Docker client:', error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.get('/api/config', (c) => {
  try {
    const diskConfig = readConfig(actions, CONFIG_PATH)
    const normalized = normalizeConfig(actions, diskConfig)
    // If file was missing/partial/empty, normalize and persist so UI always sees all keys.
    if (JSON.stringify(diskConfig) !== JSON.stringify(normalized)) {
      try {
        writeConfig(CONFIG_PATH, normalized)
      } catch {
        // ignore persistence failures; still return normalized
      }
    }
    currentConfig = normalized
    return c.json({ success: true, config: { permissions: normalized } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read config';
    logger.error('Error reading config:', error);
    return c.json({ success: false, error: message }, 500);
  }
});

app.put('/api/config', async (c) => {
  try {
    const body = await c.req.json();
    const incomingResult = validateIncomingConfig(actions, body?.config?.permissions)
    if (!incomingResult.ok) {
      return c.json({ success: false, error: incomingResult.error }, 400)
    }
    const incoming = incomingResult.value

    const previous = currentConfig
    const next = normalizeConfig(actions, incoming, previous)

    writeConfig(CONFIG_PATH, next)
    applyConfigDelta(previous, next)
    currentConfig = next

    return c.json({
      success: true,
      message: 'Config updated and applied',
      config: { permissions: next }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update config';
    logger.error('Error updating config:', error);
    return c.json({ success: false, error: message }, 500);
  }
});
// Graceful shutdown handler
let isShuttingDown = false
async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true

  logger.info(`Received ${signal}, shutting down gracefully...`)

  try {
    // Disconnect NeuroClient
    if (CONT.neuro) {
      logger.info('Disconnecting NeuroClient...')
      CONT.neuro.disconnect()
      logger.info('NeuroClient disconnected')
    }

    logger.info('Shutdown complete')
    process.exit(0)
  } catch (error) {
    logger.error('Error during shutdown:', error)
    process.exit(1)
  }
}

// Listen for shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'))

  // Start the application
  ; (function () {
    // Set action handler
    CONT.neuro.onAction(RCEActionHandler)

    // Load and apply configuration
    const config = normalizeConfig(actions, readConfig(actions, CONFIG_PATH))
    currentConfig = config
    applyConfigFull(config);

    // Remove existing socket if present
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH)
    }

    // Create HTTP server with Hono's fetch handler
    const server = createServer(async (req, res) => {
      // Convert Node.js IncomingMessage to Web API Request
      const url = new URL(req.url || '/', `http://localhost`)
      const headers = new Headers()

      Object.entries(req.headers).forEach(([key, value]) => {
        if (value) headers.set(key, Array.isArray(value) ? value[0] : value)
      })

      let body: Buffer | undefined = undefined
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          chunks.push(chunk as Buffer)
        }
        body = Buffer.concat(chunks as unknown as Uint8Array[])
      }

      const request = new Request(url.href, {
        method: req.method,
        headers,
        body: body as any
      })

      // Call Hono's fetch handler
      const response = await app.fetch(request)

      // Convert Web API Response back to Node.js ServerResponse
      res.writeHead(response.status, Object.fromEntries(response.headers))

      if (response.body) {
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      }

      res.end()
    })

    // Listen on Unix socket
    server.listen(SOCKET_PATH, () => {
      logger.info(`Backend service listening on ${SOCKET_PATH}`)
      logger.info('neurontainer is waiting for Neuro commands...')
      logger.info(`Neuro server: ${CONT.currentNeuroUrl}`)
      logger.info(`Game name: ${GAME_NAME}`)
    })
  })()

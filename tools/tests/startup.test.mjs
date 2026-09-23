import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"
import ts from "typescript"

const settle = () => new Promise((resolve) => setImmediate(resolve))

function eventChannel() {
	const listeners = new Set()
	return {
		addListener: (cb) => listeners.add(cb),
		removeListener: (cb) => listeners.delete(cb),
		emit: (...args) => Promise.all([...listeners].map((cb) => cb(...args))),
	}
}

let nextId = 0

function startupEnv({ pinned = false, overrides = {} } = {}) {
	const data = {
		"g:version": 15,
		"g:enabled": true,
		"g:speed": 1.5,
		"g:pinByDefault": true,
		"g:initialContext": 1,
		"t:1:enabled": true,
		"t:1:speed": 1.5,
		...(pinned ? { "t:1:isPinned": true } : {}),
		...overrides,
	}
	const gvar = {}
	const onChanged = eventChannel()
	let releaseRemoval
	const removalGate = new Promise((res) => (releaseRemoval = res))
	const pendingEvents = []
	const dispatch = (changes) => pendingEvents.push(() => onChanged.emit(changes))
	const chrome = {
		runtime: { onInstalled: eventChannel(), onStartup: eventChannel(), onMessage: eventChannel() },
		tabs: {
			onCreated: eventChannel(),
			onRemoved: eventChannel(),
			query: async (query) => (query.audible || query.url ? [] : [{ id: 1 }]),
		},
		storage: {
			local: {
				onChanged,
				get: async (keys) => {
					if (keys == null) return { ...data }
					return Object.fromEntries(
						(typeof keys === "string" ? [keys] : keys).filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]),
					)
				},
				set: async (override) => {
					const changes = {}
					for (const [key, value] of Object.entries(override)) {
						if (value === undefined || data[key] === value) continue
						changes[key] = { oldValue: data[key], newValue: value }
						data[key] = value
					}
					dispatch(changes)
				},
				remove: async (keys) => {
					await removalGate
					const changes = {}
					for (const key of keys) {
						if (!Object.hasOwn(data, key)) continue
						changes[key] = { oldValue: data[key] }
						delete data[key]
					}
					dispatch(changes)
				},
			},
			session: {},
			AccessLevel: { TRUSTED_AND_UNTRUSTED_CONTEXTS: "all" },
		},
	}
	const stubs = {
		"@/globalVar": { gvar },
		"lodash.debounce": (cb) => cb,
		"@/utils/helper": {
			isMobile: () => true,
			randomId: () => String(++nextId),
			listToDict: (keys, value) => Object.fromEntries(keys.map((key) => [key, value])),
		},
		"@/defaults": { getDefaultContext: () => ({ enabled: true, speed: 1 }), getDefaultState: () => ({ version: 15 }) },
		"@/utils/buildFlags": { IS_FIREFOX_BUILD: true },
		"@/utils/contextMenus": { syncContextMenu() {} },
		"@/background/utils/migrateSchema": { migrateSchema: (config) => config },
		"./badge": {},
		"./rules": {},
		"notFirefox/background/capture": {},
		"@/utils/browserUtils": {},
		"@/utils/configUtils": {},
		"@/utils/gsm": {},
		"./utils/getAutoMedia": {},
		"./utils/processKeybinds": {},
		"./utils/promo": { handlePromo() {} },
	}
	const modules = new Map()
	function load(path) {
		if (modules.has(path)) return modules.get(path)
		const exports = {}
		modules.set(path, exports)
		const { outputText } = ts.transpileModule(readFileSync(resolve(import.meta.dirname, "../..", path), "utf8"), {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
		})
		runInNewContext(outputText, {
			exports,
			chrome,
			console,
			setTimeout: () => {},
			require: (name) => {
				if (name in stubs) return stubs[name]
				if (name === "./contextMenus") return stubs["@/utils/contextMenus"]
				if (name.startsWith("@/")) return load(`src/${name.slice(2)}.ts`)
				if (name.startsWith("./")) return load(`src/background/${name.slice(2)}.ts`)
				throw new Error(`Missing dependency: ${name}`)
			},
		})
		return exports
	}
	load("src/background/index.ts")
	const state = load("src/utils/state.ts")
	return {
		gvar,
		data,
		state,
		chrome,
		releaseRemoval,
		flushOne: () => pendingEvents.shift()(),
		async flush() {
			while (pendingEvents.length) {
				await pendingEvents.shift()()
				await settle()
			}
		},
	}
}

test("startup finishes cleaning old tab state before restoring default pins", async () => {
	const env = startupEnv({ pinned: true })
	await env.gvar.es.init()
	const startup = env.chrome.runtime.onStartup.emit()
	await settle()
	// Hold cleanup while the old code starts pin restoration concurrently.
	env.releaseRemoval()
	await startup
	await settle()
	await env.flush()
	assert.equal(env.data["t:1:isPinned"], true)
	assert.equal(env.data["t:1:enabled"], true)
	const view = await env.state.fetchView(["enabled", "speed", "isPinned"], 1)
	assert.equal(view.enabled, true)
	assert.equal(view.isPinned, true)
	assert.equal(view.speed, 1.5)
})

test("a previous-tab context remains complete after reload cleanup and is inherited by a new tab", async () => {
	const env = startupEnv()
	await env.gvar.es.init()
	env.releaseRemoval()
	await env.chrome.runtime.onStartup.emit()
	await settle()
	await env.flush()
	const view = await env.state.fetchView(["enabled", "speed", "isPinned"], 1)
	assert.equal(view.enabled, env.data["t:1:enabled"])
	assert.equal(view.enabled, true)
	await env.chrome.tabs.onCreated.emit({ id: 2, openerTabId: 1 })
	await settle()
	await env.flush()
	assert.equal(env.data["t:2:isPinned"], true)
	assert.equal(env.data["t:2:enabled"], true)
	assert.equal(env.data["t:2:speed"], 1.5)
})

test("a tab opened during startup waits for its opener's restored context", async () => {
	const env = startupEnv({ pinned: true, overrides: { "t:1:enabled": false, "t:1:speed": 3 } })
	await env.gvar.es.init()
	const startup = env.chrome.runtime.onStartup.emit()
	const created = env.chrome.tabs.onCreated.emit({ id: 2, openerTabId: 1 })
	await settle()
	assert.equal(env.data["t:2:isPinned"], undefined)
	env.releaseRemoval()
	await Promise.all([startup, created])
	await env.flush()
	assert.equal(env.data["t:2:enabled"], true)
	assert.equal(env.data["t:2:speed"], 1.5)
})

test("repeated install/reload events keep storage and the background context in sync", async () => {
	let overrides = {}
	for (let reload = 0; reload < 3; reload++) {
		const env = startupEnv({ overrides })
		await env.gvar.es.init()
		env.releaseRemoval()
		await env.chrome.runtime.onInstalled.emit()
		await env.flush()
		const view = await env.state.fetchView(["enabled", "speed", "isPinned"], 1)
		assert.equal(env.data["t:1:isPinned"], true)
		assert.equal(view.isPinned, true)
		assert.equal(view.enabled, true)
		assert.equal(view.speed, 1.5)
		overrides = { ...env.data }
	}
})

test("previous-tab inheritance preserves a deliberately disabled context", async () => {
	const env = startupEnv({ overrides: { "g:enabled": false } })
	env.releaseRemoval()
	await env.chrome.runtime.onStartup.emit()
	await env.flush()
	await env.chrome.tabs.onCreated.emit({ id: 2, openerTabId: 1 })
	await env.flush()
	const view = await env.state.fetchView(["enabled", "isPinned"], 2)
	assert.equal(view.isPinned, true)
	assert.equal(view.enabled, false)
	assert.equal(env.data["t:2:enabled"], false)
})

test("delayed storage events cannot roll back newer writes, but later external edits still apply", async () => {
	const env = startupEnv({ pinned: true })
	await env.gvar.es.init()
	await env.chrome.storage.local.set({ "t:1:speed": 2, "g:hideBadge": true })
	await env.gvar.es.set({ "t:1:speed": 3 })
	await env.gvar.es.set({ "t:1:speed": 4 })
	await env.flushOne()
	let view = await env.state.fetchView(["speed", "hideBadge"], 1)
	assert.equal(view.speed, 4)
	assert.equal(view.hideBadge, true, "unrelated external changes must still be applied")
	await env.flushOne()
	assert.equal((await env.state.fetchView(["speed"], 1)).speed, 4)
	await env.flush()
	await env.chrome.storage.local.set({ "t:1:speed": 5 })
	await env.flush()
	assert.equal((await env.state.fetchView(["speed"], 1)).speed, 5)
})

test("a failed storage write does not keep masking later external changes", async () => {
	const env = startupEnv({ pinned: true })
	const set = env.chrome.storage.local.set
	env.chrome.storage.local.set = async () => {
		throw new Error("Storage unavailable")
	}
	await assert.rejects(env.gvar.es.set({ "t:1:speed": 3 }), /Storage unavailable/)
	env.chrome.storage.local.set = set
	await set({ "t:1:speed": 2 })
	await env.flush()
	assert.equal((await env.state.fetchView(["speed"], 1)).speed, 2)
})

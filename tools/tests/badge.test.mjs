import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"
import ts from "typescript"

const settle = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
	let resolve
	const promise = new Promise((res) => (resolve = res))
	return { promise, resolve }
}

function badgeEnv() {
	const startup = new Set()
	const watchers = []
	const icons = new Map()
	const texts = new Map()
	const colors = new Map()
	const state = new Map([
		[0, { enabled: true, speed: 1 }],
		[1, { enabled: true, speed: 2, isPinned: true }],
	])
	const env = { icons, texts, colors, state, setIcon: async () => {}, refresh: () => watchers[0]() }
	const imports = {
		"lodash.debounce": (cb) => cb,
		"@/globalVar": { gvar: { es: { addWatcher: (_keys, cb) => watchers.push(cb) }, sess: { safeCbs: startup } } },
		"@/utils/configUtils": { formatSpeedForBadge: String },
		"@/utils/helper": { isMobile: () => false },
		"@/utils/state": { fetchView: async (_selector, tabId) => ({ ...state.get(tabId) }) },
	}
	const { outputText } = ts.transpileModule(readFileSync(resolve(import.meta.dirname, "../../src/background/badge.ts"), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	})
	runInNewContext(outputText, {
		exports: {},
		require: (name) => imports[name],
		console,
		chrome: {
			action: {
				setBadgeText: async ({ tabId, text }) => texts.set(tabId, text),
				setBadgeBackgroundColor: async ({ tabId, color }) => colors.set(tabId, color),
				setIcon: async (details) => {
					await env.setIcon(details)
					icons.set(details.tabId, details.path[128])
				},
			},
			tabs: { query: async () => [{ id: 1 }], onActivated: { addListener() {} } },
			webNavigation: { onCommitted: { addListener() {} } },
		},
	})
	env.start = () => [...startup][0]()
	return env
}

test("a slow off icon cannot overwrite the restored pinned tab's on icon", async () => {
	const env = badgeEnv()
	const offIcon = deferred()
	env.state.set(1, { isPinned: true }) // A transient startup snapshot before the pinned context is restored.
	env.setIcon = ({ tabId, path }) => (tabId === 1 && path[128] === "images/128g.png" ? offIcon.promise : undefined)
	env.start()
	await settle()
	env.state.set(1, { enabled: true, speed: 2, isPinned: true })
	env.refresh()
	await settle()
	offIcon.resolve()
	await settle()
	assert.equal(env.icons.get(1), "images/128.png")
	assert.equal(env.texts.get(1), "2")
	assert.equal(env.colors.get(1), "#44a")
})

test("the global fallback follows current state instead of caching the first startup snapshot", async () => {
	const env = badgeEnv()
	env.state.set(0, { enabled: false })
	env.start()
	await settle()
	env.state.set(0, { enabled: true, speed: 1.5 })
	env.refresh()
	await settle()
	assert.equal(env.icons.get(undefined), "images/128.png")
	assert.equal(env.texts.get(undefined), "1.5")
	assert.equal(env.icons.get(1), "images/128.png")
})

test("a genuinely disabled pinned tab stays off while unpinned tabs keep their normal badge", async () => {
	const env = badgeEnv()
	env.state.set(1, { enabled: false, isPinned: true, hasOrl: true })
	await env.start()
	assert.equal(env.icons.get(1), "images/128g.png")
	assert.equal(env.texts.get(1), "OFF")
	env.state.set(1, { enabled: true, speed: 1 })
	env.refresh()
	await settle()
	assert.equal(env.icons.get(1), "images/128.png")
	assert.equal(env.texts.get(1), "1")
	assert.equal(env.colors.get(1), "#a33")
})

test("an icon write rejected for a closed tab does not block later refreshes", async () => {
	const env = badgeEnv()
	env.setIcon = async ({ tabId }) => {
		if (tabId === 1) throw new Error("Tab closed")
	}
	await env.start()
	env.setIcon = async () => {}
	env.refresh()
	await settle()
	assert.equal(env.icons.get(1), "images/128.png")
})

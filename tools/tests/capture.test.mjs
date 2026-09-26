import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"
import debounce from "lodash.debounce"
import ts from "typescript"

const root = resolve(import.meta.dirname, "../..")
const settle = () => new Promise((resolve) => setImmediate(resolve))

function captureEnv() {
	const data = { "g:version": 15, "g:enabled": true, "s:captured": [1, 2], "t:1:isPinned": true, "t:1:enabled": true }
	const listeners = []
	const messages = []
	const debouncers = []
	const gvar = {}
	let id = 0
	const chrome = {
		tabCapture: {},
		offscreen: {},
		runtime: { sendMessage: async (message) => messages.push(structuredClone(message)) },
		storage: {
			local: {
				onChanged: { addListener: (cb) => listeners.push(cb) },
				get: async () => structuredClone(data),
				set: async (override) => {
					const changes = {}
					for (const [key, value] of Object.entries(override)) {
						if (JSON.stringify(data[key]) === JSON.stringify(value)) continue
						changes[key] = { oldValue: data[key], newValue: value }
						data[key] = structuredClone(value)
					}
					await Promise.all(listeners.map((cb) => cb(changes)))
				},
			},
		},
	}
	const imports = {
		"@/globalVar": { gvar },
		"lodash.debounce": (cb, ...args) => {
			const debounced = debounce(cb, ...args)
			debouncers.push(debounced)
			return debounced
		},
		"@/utils/helper": { randomId: () => String(++id), listToDict: (keys, value) => Object.fromEntries(keys.map((key) => [key, value])) },
		"./contextMenus": {},
	}
	const modules = new Map()
	function load(path) {
		if (modules.has(path)) return modules.get(path)
		const exports = {}
		modules.set(path, exports)
		const source = process.env.CAPTURE_TEST_REVISION
			? execFileSync("git", ["show", `${process.env.CAPTURE_TEST_REVISION}:${path}`], { cwd: root, encoding: "utf8" })
			: readFileSync(resolve(root, path), "utf8")
		const { outputText } = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
		})
		runInNewContext(outputText, {
			exports,
			chrome,
			console,
			require: (name) => {
				if (name in imports) return imports[name]
				if (name.startsWith("@/")) return load(`src/${name.slice(2)}.ts`)
				throw new Error(`Missing dependency: ${name}`)
			},
		})
		return exports
	}
	load("src/background/utils/state.ts")
	const state = load("src/utils/state.ts")
	load("src/background/capture.ts")
	return {
		gvar,
		state,
		messages,
		async popupWrite(override) {
			await chrome.storage.local.set({ ...override, changeId: `popup-${++id}` })
			await settle()
		},
		async flush() {
			for (const debounced of debouncers) await debounced.flush()
			await settle()
		},
		release: () => debouncers.forEach((debounced) => debounced.cancel()),
	}
}

test("the final pitch reaches audio even when an unchanged enable write follows it", async () => {
	const env = captureEnv()
	try {
		await env.popupWrite({ "t:1:audioFx": { pitch: -4 } })
		assert.equal(env.messages.at(-1).updates[0].view.audioFx.pitch, -4)
		await env.popupWrite({ "t:1:audioFx": { pitch: 6 } })
		// AudioPanel.ensureCaptured writes enabled=true after moving the slider.
		// If already enabled, only the changeId is different in the storage event.
		await env.popupWrite({ "t:1:enabled": true })
		assert.equal((await env.state.fetchView(["audioFx"], 1)).audioFx.pitch, 6)
		await env.flush()
		assert.equal(env.messages.at(-1).updates[0].view.audioFx.pitch, 6)
	} finally {
		env.release()
	}
})

test("one debounce window retains audio changes for both pinned and global tabs", async () => {
	const env = captureEnv()
	try {
		await env.popupWrite({ "t:1:audioFx": { pitch: -4 } })
		await env.popupWrite({ "t:1:audioFx": { pitch: 6 } })
		await env.popupWrite({ "g:audioFx": { pitch: 3 } })
		await env.flush()
		const updates = env.messages.at(-1).updates
		assert.equal(updates.find((update) => update.tabId === 1)?.view.audioFx.pitch, 6)
		assert.equal(updates.find((update) => update.tabId === 2)?.view.audioFx.pitch, 3)
	} finally {
		env.release()
	}
})

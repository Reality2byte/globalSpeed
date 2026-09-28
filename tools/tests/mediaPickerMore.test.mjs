import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { runInNewContext } from "node:vm"
import ts from "typescript"

async function subscription(includeRemaining) {
	const { outputText } = ts.transpileModule(readFileSync(new URL("../../src/utils/SubscribeMedia.ts", import.meta.url), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	})
	const exports = {}
	const imports = {
		"@/contentScript/isolated/utils/genMediaInfo": {
			flattenMediaInfos: (scopes) => scopes.flatMap((scope) => scope.media.map((info) => ({ ...scope, ...info }))),
		},
		"@/utils/browserUtils": {},
	}
	runInNewContext(outputText, {
		exports,
		require: (key) => imports[key],
		chrome: { storage: { session: { get: async () => ({}), onChanged: { addListener() {}, removeListener() {} } } } },
	})
	const client = new exports.SubscribeMedia(1, () => {}, includeRemaining)
	await new Promise((resolve) => setImmediate(resolve))
	const media = (key, duration, extra = {}) => ({ key, duration, readyState: 4, ...extra })
	client.scopes = {
		current: { tabInfo: { tabId: 1 }, media: [media("current", 120), media("short", 5), media("unready", 900, { readyState: 0 })] },
		other: { tabInfo: { tabId: 2 }, media: [media("recent", 90, { lastPlayed: 10 }), media("long", 600), media("medium", 300), media("brief", 45), media("live", 999999999, { infinity: true })] },
	}
	client.calcLatest()
	return client
}

test("picker offers remaining media over a minute, live first then longest, without changing the default list", async () => {
	const client = await subscription(true)
	assert.deepEqual(
		Array.from(client.latestData.infos, (info) => info.key),
		["current", "recent"],
	)
	assert.deepEqual(
		Array.from(client.latestData.remainingInfos, (info) => info.key),
		["live", "long", "medium"],
	)
	client.release()
})

test("remaining media updates without duplicates when an extra becomes pinned or disappears", async () => {
	const client = await subscription(true)
	client.pinned = { key: "long", tabInfo: { tabId: 2 } }
	client.scopes.other.media = client.scopes.other.media.filter((info) => info.key !== "live")
	client.calcLatest()
	assert.ok(client.latestData.infos.some((info) => info.key === "long"))
	assert.deepEqual(
		Array.from(client.latestData.remainingInfos, (info) => info.key),
		["medium"],
	)
	client.scopes.other.media = client.scopes.other.media.filter((info) => info.key !== "medium")
	client.calcLatest()
	assert.equal(client.latestData.remainingInfos.length, 0)
	client.release()
})

test("popup subscriptions do not include the expanded picker data", async () => {
	const client = await subscription(false)
	assert.equal(client.latestData.remainingInfos, undefined)
	client.release()
})

function pickerEnv() {
	class Element {
		children = []
		dataset = {}
		attributes = {}
		listeners = {}
		append(...children) {
			this.children.push(...children)
		}
		replaceChildren() {
			this.children = []
		}
		setAttribute(key, value) {
			this.attributes[key] = value
		}
		removeAttribute(key) {
			delete this.attributes[key]
		}
		addEventListener(key, cb) {
			this.listeners[key] = cb
		}
		focus() {}
		scrollIntoView() {}
	}
	class Popover {
		_div = new Element()
		_shadow = {}
		_update() {}
		_release() {}
	}
	const gvar = {}
	const writes = []
	let deliver
	const imports = {
		"@/contentScript/isolated/utils/Popover": { Popover },
		"@/globalVar": { gvar },
		"@/utils/browserUtils": { setSession: async (value) => writes.push(value) },
		"@/utils/gsm": {},
		"@/utils/helper": { formatDuration: String },
		"@/utils/nativeUtils": { getLeaf: () => null, insertStyle() {} },
		"./styles.css?inline": {},
	}
	const { outputText } = ts.transpileModule(readFileSync(new URL("../../src/contentScript/mediaPicker/index.ts", import.meta.url), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	})
	const exports = {}
	runInNewContext(outputText, {
		exports,
		require: (key) => imports[key],
		document: { createElement: () => new Element() },
		window: { focus() {} },
		chrome: {
			runtime: {
				connect: () => ({
					onMessage: {
						addListener: (cb) => {
							deliver = cb
						},
					},
					onDisconnect: { addListener() {} },
					postMessage() {},
					disconnect() {},
				}),
			},
		},
	})
	gvar.os = { eListen: { blurCbs: new Set(), visibilityCbs: new Set() } }
	gvar.gsm = {
		command: { selectMedia: "Select media" },
		mediaPicker: { automatic: "Automatic", loading: "Loading", empty: "Empty" },
		token: { showMore: "Show more" },
	}
	const picker = new exports.MediaPicker()
	const info = (key) => ({ key, duration: 60, displayTitle: key, tabInfo: { tabId: 1 } })
	return { picker, writes, deliver, info }
}

test("Enter on Show more expands without writing a pin; extra entries can then be selected", async () => {
	const { picker, writes, deliver, info } = pickerEnv()
	deliver({ infos: [info("default")], pinned: null, remainingInfos: [info("extra"), info("short")] })
	picker.handleKeyDown({ key: "End" })
	await picker.commit()
	assert.equal(picker.expanded, true)
	assert.equal(picker.focusedKey, "extra")
	assert.equal(picker.hasMore, false)
	assert.equal(writes.length, 0)
	assert.equal(picker.released, false)
	await picker.commit()
	assert.equal(writes[0]["m:pin"].key, "extra")
	assert.equal(picker.released, true)
})

test("Show more supports clicks and disappears when the remaining list empties", () => {
	const { picker, writes, deliver, info } = pickerEnv()
	deliver({ infos: [info("default")], pinned: null, remainingInfos: [] })
	assert.equal(picker.list.children.length, 2)
	deliver({ infos: [info("default")], pinned: null, remainingInfos: [info("extra")] })
	const more = picker.list.children.at(-1)
	assert.equal(more.children[0].textContent, "Show more")
	more.listeners.pointermove()
	deliver({ infos: [info("default")], pinned: null, remainingInfos: [] })
	assert.equal(picker.focusedKey, null)
	assert.equal(picker.hasMore, false)
	deliver({ infos: [info("default")], pinned: null, remainingInfos: [info("extra")] })
	picker.list.children.at(-1).listeners.click()
	assert.equal(picker.expanded, true)
	assert.equal(picker.focusedKey, "extra")
	assert.equal(writes.length, 0)
	picker.release()
})

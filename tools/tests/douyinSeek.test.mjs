import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import { runInNewContext } from "node:vm"
import ts from "typescript"

function load(path, imports = {}, globals = {}) {
	const exports = {}
	const source = readFileSync(resolve(import.meta.dirname, "../..", path), "utf8")
	const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
	runInNewContext(outputText, {
		exports,
		require: (name) => {
			if (!(name in imports)) throw Error(`Missing import: ${name}`)
			return imports[name]
		},
		...globals,
	})
	return exports
}

function env(hostname = "www.douyin.com") {
	class MediaStream {}
	class Media {
		srcObject = new MediaStream()
		currentTime = 3
		duration = Infinity
		readyState = 4
		paused = false
		pause() {
			this.paused = true
		}
		closest() {
			return this.root
		}
	}
	class Core {
		_media = new Media()
		position = 10
		duration = 100
		writes = []
		get currentTime() {
			return this.position
		}
		set currentTime(time) {
			this.position = time
			this.writes.push(time)
		}
	}
	const media = []
	const document = { querySelectorAll: () => media }
	const globals = { document, MediaStream, HTMLMediaElement: Media, HTMLVideoElement: Media, location: { hostname } }
	const main = load("src/contentScript/main/utils/DouyinSeek.ts", {}, globals)
	const site = load("src/contentScript/isolated/utils/siteAdapters/douyin.ts", {}, globals)
	const messages = []
	const server = {
		initialized: true,
		msgCbs: new Set(),
		send(message) {
			messages.push(message)
			if (message.type === "DOUYIN_SEEK") main.seekDouyin(message.index, message.value, message.relative, message.autoPause, message.wraparound)
			if (message.type === "DOUYIN_TIME") {
				// Match the real JSON transport, including non-finite native duration.
				const reply = JSON.parse(JSON.stringify({ type: message.type, index: message.index, timeline: main.readDouyinTimeline(message.index) }))
				for (const cb of this.msgCbs) cb(reply)
			}
		},
	}
	const bridge = load(
		"src/contentScript/isolated/utils/siteAdapters/DouyinTimeline.ts",
		{ "@/globalVar": { gvar: { os: { stratumServer: server } } }, "./douyin": site },
		globals,
	)
	const apply = load(
		"src/contentScript/isolated/utils/applyMediaEvent.ts",
		{
			"@/globalVar": {},
			"@/utils/browserUtils": {},
			"@/utils/hash": {},
			"@/utils/supports": {},
			"../../../types": {},
			"../../../utils/helper": {},
			"./Cinema": {},
			"./isWebsite": {},
			"./siteAdapters/DouyinTimeline": bridge,
		},
		globals,
	)
	const add = () => {
		const core = new Core(),
			element = core._media
		element.root = { _player: { proxy: { _core: core } } }
		media.push(element)
		return { core, element }
	}
	return { main, bridge, apply, add, media, server, messages }
}

test("relative, absolute and repeated paused seeks use the decoder timeline through the bridge", () => {
	const { add, apply } = env()
	const { core, element } = add()
	apply.seek(element, 5, true, true)
	assert.equal(element.paused, true)
	assert.equal(core.currentTime, 15)
	apply.seek(element, 5, true, true)
	assert.equal(core.currentTime, 20, "a second paused seek starts at the pending decoder position")
	assert.equal(element.currentTime, 3)
	assert.equal(apply.getMediaTimeline(element).currentTime, 20)
	apply.seekTo(element, 40)
	assert.equal(core.currentTime, 40)
	assert.deepEqual(core.writes, [15, 20, 40])
})

test("wraparound uses the decoder duration in both directions and preserves end semantics", () => {
	const { add, apply } = env()
	const { core, element } = add()
	core.position = 95
	apply.seek(element, 10, true, false, true)
	assert.equal(core.currentTime, 5)
	apply.seek(element, -10, true, false, true)
	assert.equal(core.currentTime, 95)
	apply.seek(element, 5, true, false, true)
	assert.equal(core.currentTime, 100)
	apply.seekTo(element, -5)
	assert.equal(core.currentTime, 0)
	apply.seekTo(element, 999)
	assert.equal(core.currentTime, 100)
})

test("an asynchronous setter receives exactly one seek, without speculative fallbacks", () => {
	const { add, main } = env()
	const { core, element } = add()
	let calls = 0
	Object.defineProperty(core, "currentTime", { get: () => 10, set: () => calls++ })
	element.root._player.proxy.seek = () => assert.fail("unexpected fallback")
	core.seek = () => assert.fail("unexpected fallback")
	main.seekDouyin(0, 40)
	assert.equal(calls, 1)
})

test("unsupported, replaced, revoked and throwing players fail quietly", () => {
	const { add, main } = env()
	const { core, element } = add()
	for (const index of [-1, 0.5, NaN, Infinity, "0", 99]) main.seekDouyin(index, 20)
	for (const value of [NaN, Infinity, undefined, null, "20"]) main.seekDouyin(0, value)
	assert.deepEqual(core.writes, [])
	Object.defineProperty(core, "currentTime", {
		configurable: true,
		get: () => {
			throw Error("destroyed")
		},
	})
	assert.doesNotThrow(() => main.seekDouyin(0, 20, true))
	assert.equal(main.readDouyinTimeline(0), undefined)
	Object.defineProperty(core, "currentTime", { configurable: true, value: 10, writable: true })
	main.seekDouyin(0, 20)
	assert.equal(core.currentTime, 10, "a data property is not evidence of a seek API")
	core._media = {}
	assert.equal(main.readDouyinTimeline(0), undefined)
	const revoked = Proxy.revocable({}, {})
	revoked.revoke()
	element.root._player = revoked
	assert.doesNotThrow(() => main.seekDouyin(0, 20))
})

test("the exact media is resolved across video switches and timeline reads are not cached", () => {
	const { add, apply, bridge, media, server } = env()
	const first = add(),
		second = add()
	second.core.position = 40
	second.core.duration = 200
	apply.seek(second.element, 5, true)
	assert.equal(first.core.currentTime, 10)
	assert.equal(second.core.currentTime, 45)
	media.reverse()
	assert.equal(apply.getMediaTimeline(second.element).duration, 200)
	apply.seek(second.element, 5, true)
	assert.equal(second.core.currentTime, 50)
	second.element.root._player.proxy._core = first.core
	assert.equal(bridge.getDouyinTimeline(second.element), undefined)
	assert.equal(server.msgCbs.size, 0)
})

test("native players, unrelated hosts and an uninitialized bridge retain the native seek path", () => {
	for (const kind of ["native", "elsewhere", "uninitialized"]) {
		const { add, apply, server, messages } = env(kind === "elsewhere" ? "example.com" : "www.douyin.com")
		const { core, element } = add()
		if (kind === "native") element.srcObject = null
		if (kind === "uninitialized") server.initialized = false
		apply.seek(element, 5, true, true)
		assert.equal(element.currentTime, 8)
		assert.equal(apply.getMediaTimeline(element).currentTime, 8)
		assert.equal(apply.getMediaTimeline(element).duration, null)
		assert.equal(element.paused, true)
		assert.deepEqual(core.writes, [])
		assert.equal(messages.length, 0)
	}
})

test("timeline replies normalize live duration and reject malformed responses without leaking listeners", () => {
	const { add, bridge, server } = env()
	const { core, element } = add()
	core.duration = Infinity
	assert.equal(bridge.getDouyinTimeline(element).duration, null)
	server.send = () => {
		for (const cb of server.msgCbs) cb({ type: "DOUYIN_TIME", index: 0, timeline: { currentTime: NaN, duration: 100 } })
	}
	assert.equal(bridge.getDouyinTimeline(element), undefined)
	assert.equal(server.msgCbs.size, 0)
})

test("frame stepping and an initially unknown native duration reach the decoder", () => {
	const { add, apply } = env()
	const { core, element } = add()
	element.seekToNextFrame = () => assert.fail("native frame stepping cannot seek a MediaStream")
	apply.seek(element, 0.041, true, true)
	assert.equal(core.currentTime, 10.041)
	element.duration = NaN
	apply.applyMediaEvent(element, { type: "SEEK", value: 30 })
	assert.equal(core.currentTime, 30)
})

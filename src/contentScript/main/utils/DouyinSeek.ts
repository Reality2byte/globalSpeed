import type { DouyinTimeline } from "../../isolated/utils/siteAdapters/douyin"

type DouyinCore = { _media: HTMLMediaElement; currentTime: number; duration: number }
type DouyinRoot = HTMLElement & { _player?: { proxy?: { _core?: DouyinCore } } }

function resolveCore(index: number): DouyinCore | undefined {
	if (!Number.isInteger(index) || index < 0) return
	// Both worlds resolve the same media element during the synchronous dispatch.
	const media = document.querySelectorAll("video, audio")[index]
	if (!(media instanceof HTMLMediaElement)) return
	if (typeof MediaStream === "undefined" || !(media.srcObject instanceof MediaStream)) return
	const root = media.closest<DouyinRoot>(".douyin-player")
	const core = root?._player?.proxy?._core
	if (core?._media === media) return core
}

export function readDouyinTimeline(index: number): DouyinTimeline | undefined {
	try {
		const core = resolveCore(index)
		if (!core) return
		const currentTime = core.currentTime
		const duration = core.duration
		if (!Number.isFinite(currentTime)) return
		return { currentTime, duration: Number.isFinite(duration) && duration > 0 ? duration : null }
	} catch {
		// A player can be destroyed, revoked or replaced while the page is running.
	}
}

export function seekDouyin(index: number, value: number, relative = false, autoPause = false, wraparound = false) {
	try {
		if (!Number.isFinite(value)) return
		const core = resolveCore(index)
		if (!core) return
		let target = relative ? core.currentTime + value : value
		if (!Number.isFinite(target)) return
		const duration = core.duration
		if (Number.isFinite(duration) && duration > 0) {
			if (relative && wraparound && duration > 60 && (target < 0 || target > duration)) {
				target = ((target % duration) + duration) % duration
			}
			target = Math.min(target, duration)
		}
		target = Math.max(0, target)

		let owner: object = core
		let descriptor: PropertyDescriptor
		while (owner) {
			descriptor = Object.getOwnPropertyDescriptor(owner, "currentTime")
			if (descriptor) break
			owner = Object.getPrototypeOf(owner)
		}
		if (!descriptor?.set) return
		if (autoPause) core._media.pause()
		// This is the setter used by Douyin's player.seek(). Its getter exposes a
		// pending seek immediately; reading it back cannot verify decoder completion.
		// Issue exactly one seek, including when the decoder completes asynchronously.
		descriptor.set.call(core, target)
	} catch {
		// Unsupported players must not break shortcut or bridge event handling.
	}
}

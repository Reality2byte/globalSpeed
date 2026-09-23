import { gvar } from "@/globalVar"
import { DouyinSeekMessage, DouyinTimeline, DouyinTimeMessage, IS_DOUYIN } from "./douyin"

export function getDouyinMediaIndex(media: HTMLMediaElement): number {
	if (!IS_DOUYIN || typeof MediaStream === "undefined" || !(media?.srcObject instanceof MediaStream)) return -1
	if (!media.closest(".douyin-player")) return -1
	return [...document.querySelectorAll("video, audio")].indexOf(media)
}

export function requestDouyinSeek(media: HTMLMediaElement, value: number, relative = false, autoPause = false, wraparound = false) {
	const index = getDouyinMediaIndex(media)
	const server = gvar.os.stratumServer
	if (index < 0 || !server.initialized) return false
	server.send({ type: "DOUYIN_SEEK", index, value, relative, autoPause, wraparound } satisfies DouyinSeekMessage)
	return true
}

export function getDouyinTimeline(media: HTMLMediaElement): DouyinTimeline | undefined {
	const index = getDouyinMediaIndex(media)
	const server = gvar.os.stratumServer
	if (index < 0 || !server.initialized) return
	let timeline: DouyinTimeline
	const receive = (message: DouyinTimeMessage) => {
		if (message.type !== "DOUYIN_TIME" || message.index !== index) return
		const value = message.timeline
		if (!value || !Number.isFinite(value.currentTime)) return
		if (value.duration !== null && !(Number.isFinite(value.duration) && value.duration > 0)) return
		timeline = value
	}
	server.msgCbs.add(receive)
	try {
		// Stratum dispatches DOM events synchronously. Request a fresh snapshot so a
		// paused seek or replacement player cannot inherit an old cached timeline.
		server.send({ type: "DOUYIN_TIME", index } satisfies DouyinTimeMessage)
		return timeline
	} finally {
		server.msgCbs.delete(receive)
	}
}

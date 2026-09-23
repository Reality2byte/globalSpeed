export const IS_DOUYIN = location.hostname === "douyin.com" || location.hostname.endsWith(".douyin.com")

export type DouyinSpeedMessage = { type: "DOUYIN_SPEED"; speed: number | null }

export type DouyinTimeline = { currentTime: number; duration: number | null }
export type DouyinSeekMessage = {
	type: "DOUYIN_SEEK"
	index: number
	value: number
	relative?: boolean
	autoPause?: boolean
	wraparound?: boolean
}
export type DouyinTimeMessage = { type: "DOUYIN_TIME"; index: number; timeline?: DouyinTimeline }

import { SubscribeMedia } from "@/utils/SubscribeMedia"

// Content scripts cannot query tabs to validate the media scopes themselves.
// Keep the same subscription as the popup in the background, for the life of the picker.
chrome.runtime.onConnect.addListener((port) => {
	if (port.name !== "media-picker" || !port.sender?.tab?.id) return
	let client: SubscribeMedia
	port.onMessage.addListener(() => {
		if (client) return
		client = new SubscribeMedia(
			port.sender.tab.id,
			(data) => {
				try {
					port.postMessage(data)
				} catch {
					client?.release()
				}
			},
			true,
		)
	})
	port.onDisconnect.addListener(() => client?.release())
})

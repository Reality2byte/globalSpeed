import type { MediaData } from "@/contentScript/isolated/utils/genMediaInfo"
import { Popover } from "@/contentScript/isolated/utils/Popover"
import { gvar } from "@/globalVar"
import { setSession } from "@/utils/browserUtils"
import { requestGsm } from "@/utils/gsm"
import { formatDuration } from "@/utils/helper"
import { getLeaf, insertStyle } from "@/utils/nativeUtils"
import styles from "./styles.css?inline"

const SHOW_MORE = "__gs_show_more__"

declare global {
	interface GlobalVar {
		openingMediaPicker?: boolean
	}
}

export class MediaPicker extends Popover {
	released = false
	private port: chrome.runtime.Port
	private previousFocus = getLeaf(document, "activeElement") as HTMLElement
	private list = document.createElement("div")
	private status = document.createElement("div")
	private data?: MediaData
	private focusedKey: string = null
	private saving = false
	private expanded = false
	private get infos() {
		return [...(this.data?.infos ?? []), ...(this.expanded ? (this.data?.remainingInfos ?? []) : [])]
	}
	private get hasMore() {
		return !this.expanded && !!this.data?.remainingInfos?.length
	}
	private get optionKeys() {
		return [null, ...this.infos.map((info) => info.key), ...(this.hasMore ? [SHOW_MORE] : [])]
	}

	constructor() {
		super()
		insertStyle(styles, this._shadow)
		this._div.setAttribute("role", "listbox")
		this._div.setAttribute("aria-label", gvar.gsm.command.selectMedia)
		this._div.tabIndex = -1
		this.list.className = "options"
		// Keep focus on the parent while interacting with its options.
		this.list.addEventListener("pointerdown", (event) => event.preventDefault())
		this.status.setAttribute("role", "status")
		this.status.textContent = gvar.gsm.mediaPicker.loading
		this._div.append(this.list, this.status)
		this.render()
		gvar.os.eListen.keyCapture = this.handleKeyDown
		gvar.os.eListen.visibilityCbs.add(this.handleVisibility)
		this._div.addEventListener("focusout", this.handleFocusOut)
		this._update(true)
		window.focus()
		this._div.focus({ preventScroll: true })
		gvar.os.eListen.blurCbs.add(this.handleBlur)
		this.port = chrome.runtime.connect({ name: "media-picker" })
		this.port.onMessage.addListener(this.handleData)
		this.port.onDisconnect.addListener(this.handleDisconnect)
		this.port.postMessage({ type: "START" })
	}

	private handleData = (data: MediaData) => {
		if (this.released) return
		if (!this.data) this.focusedKey = data.pinned?.key ?? null
		this.data = data
		if (!this.optionKeys.includes(this.focusedKey)) this.focusedKey = null
		this.status.textContent = ""
		this.render()
	}

	private render = () => {
		this.list.replaceChildren()
		const infos = this.infos
		this.optionKeys.forEach((key, index) => {
			const info = infos.find((info) => info.key === key)
			const row = document.createElement("div")
			row.id = `media-option-${index}`
			row.setAttribute("role", "option")
			row.dataset.key = key ?? ""
			row.className = "option"
			const label = document.createElement("div")
			label.className = "title"
			label.textContent =
				key === SHOW_MORE
					? gvar.gsm.token.showMore
					: info
						? info.displayTitle || info.title || info.displayDomain || info.domain
						: gvar.gsm.mediaPicker.automatic
			row.append(label)
			if (info) {
				const detail = document.createElement("div")
				detail.className = "detail"
				detail.textContent = `${info.displayDomain || info.domain} · ${info.infinity ? "∞" : formatDuration(info.duration)}`
				row.append(detail)
			}
			row.addEventListener("click", () => {
				this.focusedKey = key
				void this.commit()
			})
			row.addEventListener("pointermove", () => {
				if (this.focusedKey === key) return
				this.focusedKey = key
				this.syncSelection()
			})
			this.list.append(row)
		})
		this.syncSelection(true)
	}

	private syncSelection = (scroll = false) => {
		this._div.removeAttribute("aria-activedescendant")
		for (const row of this.list.children as HTMLCollectionOf<HTMLElement>) {
			const focused = row.dataset.key === (this.focusedKey ?? "")
			row.setAttribute("aria-selected", String(row.dataset.key === (this.data?.pinned?.key ?? "")))
			row.dataset.focused = String(focused)
			if (!focused) continue
			this._div.setAttribute("aria-activedescendant", row.id)
			if (scroll) row.scrollIntoView({ block: "nearest" })
		}
	}

	handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			this.release()
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Tab") {
			const keys = this.optionKeys
			const direction = event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1
			this.focusedKey = keys[(keys.indexOf(this.focusedKey) + direction + keys.length) % keys.length]
			this.syncSelection(true)
		} else if (event.key === "Home" || event.key === "End") {
			this.focusedKey = event.key === "Home" ? null : this.optionKeys.at(-1)
			this.syncSelection(true)
		} else if (event.key === "Enter") {
			void this.commit()
		} else if (event.key === "Delete" || event.key === "Backspace") {
			this.focusedKey = null
			void this.commit()
		}
	}

	private commit = async () => {
		if (this.saving) return
		if (this.focusedKey === SHOW_MORE) {
			this.expanded = true
			this.focusedKey = this.data?.remainingInfos?.[0]?.key ?? null
			this.render()
			return
		}
		const info = this.infos.find((info) => info.key === this.focusedKey)
		this.saving = true
		try {
			await setSession({ "m:pin": info ? { key: info.key, tabInfo: info.tabInfo } : null })
			this.release()
		} catch {
			if (!this.released) this.status.textContent = gvar.gsm.mediaPicker.failed
		} finally {
			this.saving = false
		}
	}

	private handleDisconnect = () => {
		if (!this.released) this.status.textContent = gvar.gsm.mediaPicker.failed
	}
	private handleVisibility = () => {
		if (document.hidden) this.release(false)
	}
	private handleBlur = () => this.release(false)
	private handleFocusOut = () => {
		queueMicrotask(() => {
			if (!this.released && !this._shadow.activeElement) this.release(false)
		})
	}
	release = (restoreFocus = true) => {
		if (this.released) return
		this.released = true
		this.port?.disconnect()
		if (gvar.os.eListen.keyCapture === this.handleKeyDown) delete gvar.os.eListen.keyCapture
		gvar.os.eListen.visibilityCbs.delete(this.handleVisibility)
		gvar.os.eListen.blurCbs.delete(this.handleBlur)
		if (gvar.os.mediaPicker === this) delete gvar.os.mediaPicker
		this._release()
		if (restoreFocus && this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true })
	}
}

async function toggleMediaPicker() {
	if (!gvar.os || gvar.os.released || !gvar.isTopFrame || gvar.openingMediaPicker) return
	if (gvar.os.mediaPicker) {
		gvar.os.mediaPicker.release()
		return
	}
	gvar.openingMediaPicker = true
	try {
		gvar.gsm = await requestGsm()
		if (!gvar.os.released && gvar.gsm) gvar.os.mediaPicker = new MediaPicker()
	} finally {
		gvar.openingMediaPicker = false
	}
}

void toggleMediaPicker()

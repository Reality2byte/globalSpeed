import { gvar } from "@/globalVar"

declare global {
	interface GlobalVar {
		sess: Session
	}
}

class Session {
	installCbs: Set<() => void> = new Set()
	safeCbs: Set<() => void> = new Set()
	safeStartupCbs: Set<() => void> = new Set()
	ready?: Promise<void>
	#loadedForSession = false
	constructor() {
		chrome.runtime.onInstalled.addListener(this.handleInstall)
		chrome.runtime.onStartup.addListener(this.handleStartup)
	}
	handleInstall = async () => {
		if (this.#loadedForSession) return
		this.#loadedForSession = true
		this.installCbs.forEach((cb) => cb())
		this.ready = this.handleCommon()
		await this.ready
	}
	handleStartup = async () => {
		if (this.#loadedForSession) return
		this.#loadedForSession = true
		this.ready = this.handleCommon()
		await this.ready
	}
	handleCommon = async () => {
		await gvar.installPromise
		await Promise.all([...this.safeCbs].map((cb) => cb()))
		await Promise.all([...this.safeStartupCbs].map((cb) => cb()))
	}
}

gvar.sess = new Session()

export {}

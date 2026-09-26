import { useEffect, useMemo, useState } from "react"
import { gvar } from "@/globalVar"
import { SubscribeMedia } from "@/utils/SubscribeMedia"
import { MediaData } from "../contentScript/isolated/utils/genMediaInfo"

type Env = {
	client: SubscribeMedia
}

export function useMediaWatch(): MediaData {
	const [watchInfo, setWatchInfo] = useState(null as MediaData)
	const env = useMemo<Env>(() => ({}) as Env, [])

	useEffect(() => {
		env.client = new SubscribeMedia(gvar.tabInfo?.tabId, setWatchInfo)
		return () => {
			env.client.release()
			delete env.client
		}
	}, [])

	return watchInfo
}

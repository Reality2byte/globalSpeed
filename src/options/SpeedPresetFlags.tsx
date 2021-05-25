import produce from "immer"
import { pushView } from "../background/GlobalState"
import { NumericInput } from "../comps/NumericInput"
import { Reset } from "../comps/Reset"
import { getDefaultSpeedPresets, getDefaultSpeedSlider } from "../defaults"
import { useStateView } from "../hooks/useStateView"
import "./SpeedPresetFlags.scss"

export function SpeedPresetFlags(props: {className?: string}) {
  const [view] = useStateView({speedPresets: true, speedBigStep: true, speedSmallStep: true, speedSlider: true})
  if (!view) return null 

  const presets = view.speedPresets?.length === 12 ? view.speedPresets : getDefaultSpeedPresets()

  const handlePresetChange = (idx: number, newValue: number) => {
    pushView({override: {
      speedPresets: produce(presets, d => {
        d[idx] = newValue
      })
    }})
  }

  const handleStepChange = (newValue: number, big?: boolean) => {
    pushView({override: {
      [big ? "speedBigStep" : "speedSmallStep"]: newValue
    }})
  }

  const handleSliderChange = (min: number, max: number) => {
    pushView({override: {
     speedSlider: {min, max}
    }})
  }

  const defaultSlider = getDefaultSpeedSlider()

  const resetActive = ![view.speedPresets ?? null, view.speedSmallStep ?? null, view.speedBigStep ?? null, view.speedSlider?.min === defaultSlider.min && null, view.speedSlider?.max === defaultSlider.max && null].every(v => v === null)

  return <>
    <div className="field marginTop">
      <div>
        <span style={{marginRight: "10px"}}>{window.gsm.options.editor.speedPresets}</span>
        <Reset active={resetActive} onClick={() => {
          pushView({override: {speedPresets: null, speedSmallStep: null, speedBigStep: null, speedSlider: getDefaultSpeedSlider()}})
        }}/>
      </div>
    </div>
    <div className="presetControl">
      {presets.map((v, i) => (
        <NumericInput key={i} value={v} onChange={t => handlePresetChange(i, t)} min={0.07} max={16} noNull={true}/>
      ))}
      <span>{">"}</span>
      <NumericInput value={view.speedSmallStep || 0.01} onChange={t => handleStepChange(t, false)} min={0.001} noNull={false} placeholder={"0.01"}/>
      <span>{">>"}</span>
      <NumericInput value={view.speedBigStep || 0.1} onChange={t => handleStepChange(t, true)} min={0.001} noNull={false} placeholder={"0.1"}/>
      <NumericInput disabled={!view.speedSlider} value={view.speedSlider?.min ?? defaultSlider.min} onChange={t => handleSliderChange(t, view.speedSlider?.max ?? defaultSlider.max)} min={0.07} max={16} noNull={true}/>
      <input type="checkbox" checked={!!view.speedSlider} onChange={v => pushView({override: {speedSlider: view.speedSlider ? null : getDefaultSpeedSlider()}})}/>
      <NumericInput disabled={!view.speedSlider} value={view.speedSlider?.max ?? defaultSlider.max} onChange={t => handleSliderChange(view.speedSlider?.min ?? defaultSlider.min, t)} min={0.07} max={16} noNull={true}/>
    </div>

  </>
}
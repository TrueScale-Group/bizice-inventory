let _ctx = null
const ctx = () => {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)()
  return _ctx
}

export function beepClick() {
  try {
    const o = ctx().createOscillator(), g = ctx().createGain()
    o.connect(g); g.connect(ctx().destination)
    o.frequency.value = 880; o.type = 'sine'
    g.gain.setValueAtTime(0.15, ctx().currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ctx().currentTime + 0.1)
    o.start(); o.stop(ctx().currentTime + 0.1)
  } catch {}
}

export function beepSuccess() {
  [523, 659, 784].forEach((f, i) => {
    setTimeout(() => {
      try {
        const o = ctx().createOscillator(), g = ctx().createGain()
        o.connect(g); g.connect(ctx().destination)
        o.frequency.value = f; o.type = 'sine'
        g.gain.setValueAtTime(0.12, ctx().currentTime)
        g.gain.exponentialRampToValueAtTime(0.001, ctx().currentTime + 0.15)
        o.start(); o.stop(ctx().currentTime + 0.15)
      } catch {}
    }, i * 90)
  })
}

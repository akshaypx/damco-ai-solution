import { useEffect, useState } from 'react'

const KEY = 'meals'
const load = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) || [] } catch { return [] }
}

// Shrink on-device: faster upload, stays under Vercel's 4.5MB body limit.
async function shrink(file, max = 1024) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * s)
  c.height = Math.round(bmp.height * s)
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8))
}

const today = (ts) => new Date(ts).toDateString() === new Date().toDateString()
const sum = (meals, k) => Math.round(meals.reduce((a, m) => a + m[k], 0))

export default function App() {
  const [meals, setMeals] = useState(load)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(meals)) } catch {}
  }, [meals])

  async function onPick(e) {
    const file = e.target.files[0]
    e.target.value = '' // allow re-picking the same photo
    if (!file) return
    setBusy(true)
    setErr('')
    try {
      const fd = new FormData()
      fd.append('image', await shrink(file), 'meal.jpg')
      const r = await fetch('/api/analyze', { method: 'POST', body: fd })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText)
      const meal = await r.json()
      setMeals((m) => [{ ...meal, id: crypto.randomUUID(), ts: Date.now() }, ...m])
    } catch (x) {
      setErr(String(x.message || x))
    } finally {
      setBusy(false)
    }
  }

  const t = meals.filter((m) => today(m.ts))

  return (
    <main>
      <h1>Today</h1>
      <section className="totals">
        <div><b>{sum(t, 'calories')}</b><span>kcal</span></div>
        <div><b>{sum(t, 'protein_g')}g</b><span>protein</span></div>
        <div><b>{sum(t, 'carbs_g')}g</b><span>carbs</span></div>
        <div><b>{sum(t, 'fat_g')}g</b><span>fat</span></div>
      </section>

      {err && <p className="err">{err}</p>}

      {t.map((m) => (
        <article key={m.id}>
          <header>
            <h3>{m.name}</h3>
            <button aria-label="Delete meal" onClick={() => setMeals((a) => a.filter((x) => x.id !== m.id))}>×</button>
          </header>
          <p className="items">{m.items.join(', ')}</p>
          <p>
            <b>{m.calories} kcal</b> · P {m.protein_g}g · C {m.carbs_g}g · F {m.fat_g}g · Fiber {m.fiber_g}g · Sugar {m.sugar_g}g
          </p>
          {m.confidence < 0.5 && <p className="err">Low confidence estimate</p>}
        </article>
      ))}

      <label className={'fab' + (busy ? ' busy' : '')}>
        {busy ? 'Analyzing…' : '📷 Snap meal'}
        <input type="file" accept="image/*" capture="environment" onChange={onPick} disabled={busy} hidden />
      </label>
    </main>
  )
}

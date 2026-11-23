import { useCallback, useEffect, useState } from 'react'

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parse = (s) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))
const shift = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d) }
const fmt = (n) => Math.round(n).toLocaleString()

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

async function api(path, { token, ...opts } = {}) {
  const r = await fetch('/api' + path, { ...opts, headers: { Authorization: `Bearer ${token}` } })
  if (r.status === 204) return null
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(body.detail || r.statusText), { status: r.status })
  return body
}

// ---------- login ----------
function Login({ onToken }) {
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    const f = new FormData(e.target)
    setBusy(true)
    setErr('')
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: f.get('username'), password: f.get('password') }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.detail || 'Could not sign in')
      onToken(body.token)
    } catch (x) {
      setErr(x.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit}>
        <h1>Calorie Tracker</h1>
        <p>Sign in to see your meals.</p>
        <label>Username<input name="username" autoComplete="username" required autoFocus /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  )
}

// ---------- the day's totals, styled like a food label ----------
const ROWS = [
  ['protein_g', 'Protein', 'p'],
  ['carbs_g', 'Carbohydrate', 'c'],
  ['fat_g', 'Fat', 'f'],
  ['fiber_g', 'Fiber'],
  ['sugar_g', 'Sugar'],
]

function Facts({ meals }) {
  const t = Object.fromEntries(['calories', ...ROWS.map((r) => r[0])].map((k) => [k, meals.reduce((a, m) => a + m[k], 0)]))
  const kcal = { p: t.protein_g * 4, c: t.carbs_g * 4, f: t.fat_g * 9 }
  const total = kcal.p + kcal.c + kcal.f

  return (
    <aside className="facts" aria-label="Totals for the day">
      <h2>Nutrition facts</h2>
      <p className="count">{meals.length === 1 ? '1 meal' : `${meals.length} meals`} logged</p>
      <div className="cal">
        <span>Calories</span>
        <b>{fmt(t.calories)}</b>
      </div>
      <div className="split" aria-hidden="true">
        {total > 0 && ['p', 'c', 'f'].map((k) => <i key={k} className={k} style={{ flexGrow: kcal[k] }} />)}
      </div>
      <dl>
        {ROWS.map(([k, label, dot]) => (
          <div key={k}>
            <dt>{dot && <i className={'dot ' + dot} />}{label}</dt>
            <dd>{fmt(t[k])}g</dd>
          </div>
        ))}
      </dl>
    </aside>
  )
}

// ---------- the day view ----------
function Day({ token, onLogout }) {
  const today = ymd(new Date())
  const [day, setDay] = useState(today)
  const [meals, setMeals] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const call = useCallback(async (path, opts) => {
    try {
      return await api(path, { token, ...opts })
    } catch (x) {
      if (x.status === 401) onLogout()
      throw x
    }
  }, [token, onLogout])

  useEffect(() => {
    let stale = false
    setErr('')
    call(`/meals?day=${day}`).then((m) => !stale && setMeals(m), (x) => !stale && setErr(x.message))
    return () => { stale = true }
  }, [day, call])

  async function onPick(e) {
    const file = e.target.files[0]
    e.target.value = '' // allow re-picking the same photo
    if (!file) return
    setBusy(true)
    setErr('')
    try {
      const fd = new FormData()
      fd.append('image', await shrink(file), 'meal.jpg')
      fd.append('day', day)
      const meal = await call('/analyze', { method: 'POST', body: fd })
      setMeals((m) => [meal, ...m])
    } catch (x) {
      setErr(x.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id) {
    try {
      await call(`/meals/${id}`, { method: 'DELETE' })
      setMeals((m) => m.filter((x) => x.id !== id))
    } catch (x) {
      setErr(x.message)
    }
  }

  const label = day === today ? 'Today' : parse(day).toLocaleDateString(undefined, { weekday: 'long' })
  const sub = parse(day).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="app">
      <header className="bar">
        <button className="step" onClick={() => setDay(shift(day, -1))} aria-label="Previous day">‹</button>
        <label className="date">
          <strong>{label}</strong>
          <span>{sub}</span>
          <input type="date" value={day} max={today} aria-label="Pick a date"
            onChange={(e) => e.target.value && setDay(e.target.value)} />
        </label>
        <button className="step" onClick={() => setDay(shift(day, 1))} disabled={day >= today} aria-label="Next day">›</button>
        <button className="link" onClick={onLogout}>Sign out</button>
      </header>

      <div className="grid">
        <Facts meals={meals} />
        <section className="log" aria-label="Meals">
          {err && <p className="err" role="alert">{err}</p>}
          {busy && (
            <article className="meal pending" aria-live="polite">
              <div><h3>Analyzing photo…</h3><p className="items">Estimating calories and macros</p></div>
            </article>
          )}
          {meals.map((m) => (
            <article key={m.id} className="meal">
              <div className="main">
                <time>{new Date(m.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
                <h3>{m.name}</h3>
                <p className="items">{m.items.join(', ')}</p>
                <p className="macros">
                  <span><i className="dot p" />Protein {fmt(m.protein_g)}g</span>
                  <span><i className="dot c" />Carbs {fmt(m.carbs_g)}g</span>
                  <span><i className="dot f" />Fat {fmt(m.fat_g)}g</span>
                </p>
                {m.confidence < 0.5 && <p className="warn">Rough estimate. Check the portion size.</p>}
              </div>
              <div className="side">
                <b>{fmt(m.calories)}</b>
                <span>kcal</span>
                <button className="link" onClick={() => remove(m.id)} aria-label={`Remove ${m.name}`}>Remove</button>
              </div>
            </article>
          ))}
          {!meals.length && !busy && !err && (
            <p className="empty">Nothing logged for this day. Snap a meal to add it.</p>
          )}
        </section>
      </div>

      <label className={'snap' + (busy ? ' busy' : '')}>
        {busy ? 'Analyzing photo…' : 'Snap a meal'}
        <input type="file" accept="image/*" capture="environment" onChange={onPick} disabled={busy} hidden />
      </label>
    </div>
  )
}

// ---------- root ----------
export default function App() {
  const [token, setToken] = useState(() => {
    try { return localStorage.getItem('token') } catch { return null }
  })
  const set = useCallback((t) => {
    try { t ? localStorage.setItem('token', t) : localStorage.removeItem('token') } catch {}
    setToken(t)
  }, [])
  const logout = useCallback(() => set(null), [set])

  return token ? <Day token={token} onLogout={logout} /> : <Login onToken={set} />
}

import base64
import hashlib
import hmac
import os
import time
from datetime import date, datetime
from uuid import UUID

import psycopg
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from google import genai
from google.genai import types
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel

app = FastAPI()
MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
MAX_BYTES = 4_000_000  # Vercel request body cap is 4.5MB; client shrinks images well below this
TOKEN_DAYS = 30

PROMPT = (
    "You are a nutrition expert. Identify the food in this photo and estimate the "
    "nutrition for the whole portion shown. If it is not food, return calories 0 and "
    "confidence 0. Be realistic, not precise: round sensibly."
)


class Meal(BaseModel):
    name: str
    items: list[str]
    calories: int
    protein_g: float
    carbs_g: float
    fat_g: float
    fiber_g: float
    sugar_g: float
    confidence: float  # 0..1


class SavedMeal(Meal):
    id: UUID
    day: date
    created_at: datetime


# ---- auth: one hard-coded user from env, stateless signed token ----
# ponytail: single user from env; swap for a users table when real signup is needed


def _sign(msg: str) -> str:
    return hmac.new(os.environ["AUTH_SECRET"].encode(), msg.encode(), hashlib.sha256).hexdigest()


def make_token(user: str) -> str:
    p = f"{user}|{int(time.time()) + TOKEN_DAYS * 86400}"
    return base64.urlsafe_b64encode(p.encode()).decode() + "." + _sign(p)


def read_token(tok: str) -> str | None:
    try:
        b, sig = tok.split(".")
        p = base64.urlsafe_b64decode(b).decode()
        user, exp = p.rsplit("|", 1)
        if hmac.compare_digest(sig, _sign(p)) and int(exp) > time.time():
            return user
    except Exception:
        pass
    return None


def current_user(authorization: str = Header("")) -> str:
    user = read_token(authorization.removeprefix("Bearer "))
    if not user:
        raise HTTPException(401, "Sign in required")
    return user


class Login(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(b: Login):
    u, p = os.environ.get("APP_USER", ""), os.environ.get("APP_PASSWORD", "")
    ok = u and p and hmac.compare_digest(b.username.encode(), u.encode()) and hmac.compare_digest(
        b.password.encode(), p.encode()
    )
    if not ok:
        raise HTTPException(401, "Wrong username or password")
    return {"token": make_token(u)}


# ---- db: plain SQL, Postgres everywhere (use Neon's pooled URL on Vercel) ----

SCHEMA = """
create table if not exists meals (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  day date not null,
  created_at timestamptz not null default now(),
  name text not null,
  items jsonb not null,
  calories int not null,
  protein_g real not null, carbs_g real not null, fat_g real not null,
  fiber_g real not null, sugar_g real not null,
  confidence real not null
);
create index if not exists meals_user_day on meals (user_id, day);
"""
COLS = "id, day, created_at, name, items, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, confidence"
_ready = False


async def db():
    global _ready
    # ponytail: connection per request; add a pool if latency shows up
    c = await psycopg.AsyncConnection.connect(os.environ["DATABASE_URL"], row_factory=dict_row, autocommit=True)
    if not _ready:
        await c.execute(SCHEMA)
        _ready = True
    return c


async def save_meal(user: str, day: date, m: Meal) -> dict:
    async with await db() as c:
        cur = await c.execute(
            f"insert into meals (user_id, day, name, items, calories, protein_g, carbs_g, fat_g,"
            f" fiber_g, sugar_g, confidence) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning {COLS}",
            (user, day, m.name, Jsonb(m.items), m.calories, m.protein_g, m.carbs_g, m.fat_g,
             m.fiber_g, m.sugar_g, m.confidence),
        )
        return await cur.fetchone()


async def list_meals(user: str, day: date) -> list[dict]:
    async with await db() as c:
        cur = await c.execute(
            f"select {COLS} from meals where user_id = %s and day = %s order by created_at desc", (user, day)
        )
        return await cur.fetchall()


async def delete_meal(user: str, id: UUID) -> bool:
    async with await db() as c:
        cur = await c.execute("delete from meals where id = %s and user_id = %s", (id, user))
        return cur.rowcount > 0


# ---- routes ----


@app.get("/api/meals", response_model=list[SavedMeal])
async def meals(day: date, user: str = Depends(current_user)):
    return await list_meals(user, day)


@app.delete("/api/meals/{id}", status_code=204)
async def remove(id: UUID, user: str = Depends(current_user)):
    if not await delete_meal(user, id):
        raise HTTPException(404, "Meal not found")


@app.post("/api/analyze", response_model=SavedMeal)
async def analyze(image: UploadFile = File(...), day: date = Form(...), user: str = Depends(current_user)):
    if not (image.content_type or "").startswith("image/"):
        raise HTTPException(415, "Upload an image")
    data = await image.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Image too large")
    try:
        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        r = await client.aio.models.generate_content(
            model=MODEL,
            contents=[types.Part.from_bytes(data=data, mime_type=image.content_type), PROMPT],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=Meal,
                temperature=0.2,
            ),
        )
    except Exception as e:
        raise HTTPException(502, f"Gemini error: {e}")
    meal = r.parsed
    if meal is None:
        raise HTTPException(502, "Gemini returned no result")
    if meal.calories == 0 and meal.confidence == 0:
        raise HTTPException(422, "No food found in that photo. Try again with the meal in frame.")
    return await save_meal(user, day, meal)

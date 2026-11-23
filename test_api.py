import os
import time
from datetime import date, datetime
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

os.environ.setdefault("GEMINI_API_KEY", "test")  # real key not needed, Gemini is mocked
os.environ.setdefault("AUTH_SECRET", "test-secret")
os.environ.setdefault("APP_USER", "demo")
os.environ.setdefault("APP_PASSWORD", "pw")

from fastapi.testclient import TestClient

from api.index import Meal, app, make_token, read_token

c = TestClient(app)
AUTH = {"Authorization": "Bearer " + make_token("demo")}
IMG = {"image": ("a.jpg", b"x", "image/jpeg")}
APPLE = Meal(name="Apple", items=["apple"], calories=95, protein_g=0.5, carbs_g=25,
             fat_g=0.3, fiber_g=4, sugar_g=19, confidence=0.9)


def saved(m):
    return {**m.model_dump(), "id": str(uuid4()), "day": date(2026, 1, 1), "created_at": datetime.now()}


def gemini(meal):
    p = patch("api.index.genai.Client")
    client = p.start()
    client.return_value.aio.models.generate_content = AsyncMock(return_value=MagicMock(parsed=meal))
    return p


def test_login():
    assert c.post("/api/login", json={"username": "demo", "password": "pw"}).status_code == 200
    assert c.post("/api/login", json={"username": "demo", "password": "nope"}).status_code == 401


def test_token_checks():
    assert c.get("/api/meals?day=2026-01-01").status_code == 401
    assert c.get("/api/meals?day=2026-01-01", headers={"Authorization": "Bearer x.y"}).status_code == 401
    tok = make_token("demo")
    assert read_token(tok) == "demo"
    assert read_token(tok[:-1] + ("0" if tok[-1] != "0" else "1")) is None  # tampered
    with patch("api.index.time.time", return_value=time.time() + 31 * 86400):
        assert read_token(tok) is None  # expired


def test_rejects_non_image():
    r = c.post("/api/analyze", data={"day": "2026-01-01"}, files={"image": ("a.txt", b"hi", "text/plain")}, headers=AUTH)
    assert r.status_code == 415


def test_analyze_saves_meal():
    p = gemini(APPLE)
    try:
        with patch("api.index.save_meal", AsyncMock(return_value=saved(APPLE))) as s:
            r = c.post("/api/analyze", data={"day": "2026-01-01"}, files=IMG, headers=AUTH)
    finally:
        p.stop()
    assert r.status_code == 200 and r.json()["calories"] == 95
    assert s.call_args.args[0] == "demo" and s.call_args.args[1] == date(2026, 1, 1)


def test_no_food_is_not_saved():
    p = gemini(APPLE.model_copy(update={"calories": 0, "confidence": 0}))
    try:
        with patch("api.index.save_meal", AsyncMock()) as s:
            r = c.post("/api/analyze", data={"day": "2026-01-01"}, files=IMG, headers=AUTH)
    finally:
        p.stop()
    assert r.status_code == 422 and not s.called

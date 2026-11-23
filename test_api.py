import os

os.environ.setdefault("GEMINI_API_KEY", "test")  # real key not needed, Gemini is mocked

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

from api.index import Meal, app

c = TestClient(app)


def test_rejects_non_image():
    assert c.post("/api/analyze", files={"image": ("a.txt", b"hi", "text/plain")}).status_code == 415


def test_returns_meal():
    meal = Meal(name="Apple", items=["apple"], calories=95, protein_g=0.5, carbs_g=25,
                fat_g=0.3, fiber_g=4, sugar_g=19, confidence=0.9)
    with patch("api.index.genai.Client") as client:
        client.return_value.aio.models.generate_content = AsyncMock(return_value=MagicMock(parsed=meal))
        r = c.post("/api/analyze", files={"image": ("a.jpg", b"x", "image/jpeg")})
    assert r.status_code == 200 and r.json()["calories"] == 95

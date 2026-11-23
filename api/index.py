import os

from fastapi import FastAPI, File, HTTPException, UploadFile
from google import genai
from google.genai import types
from pydantic import BaseModel

app = FastAPI()
MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
MAX_BYTES = 4_000_000  # Vercel request body cap is 4.5MB; client shrinks images well below this

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


@app.post("/api/analyze", response_model=Meal)
async def analyze(image: UploadFile = File(...)):
    if not (image.content_type or "").startswith("image/"):
        raise HTTPException(415, "Upload an image")
    data = await image.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Image too large")
    try:
        # ponytail: client per request; cache it if it ever shows in profiles
        # vertexai=True because the key is a Vertex AI express-mode key (starts "AQ.")
        client = genai.Client(vertexai=True, api_key=os.environ["GEMINI_API_KEY"])
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
    if r.parsed is None:
        raise HTTPException(502, "Gemini returned no result")
    return r.parsed

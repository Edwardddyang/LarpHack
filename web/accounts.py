"""Accounts: email/password sign-in and per-user storage of training data.

Uses Postgres when DATABASE_URL is set (Render), otherwise a local SQLite file.
Passwords are hashed with scrypt; sessions are random tokens in an HttpOnly cookie.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path

from fastapi import APIRouter, Cookie, HTTPException, Request, Response
from sqlalchemy import Column, Float, ForeignKey, Integer, MetaData, String, Table, Text, create_engine, select

ROOT = Path(__file__).resolve().parent.parent
COOKIE = "ae_session"
SESSION_DAYS = 60
# Client-side stores that sync to the account (see static/core.js).
DATA_KEYS = {"sessions", "goal", "plan", "chat", "last"}
MAX_VALUE_BYTES = 512_000


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        (ROOT / "data").mkdir(exist_ok=True)
        return f"sqlite:///{ROOT / 'data' / 'app.db'}"
    # Render hands out postgres:// URLs; SQLAlchemy wants an explicit driver.
    return re.sub(r"^postgres(ql)?://", "postgresql+psycopg://", url)


engine = create_engine(_database_url(), pool_pre_ping=True)
meta = MetaData()
users = Table(
    "users", meta,
    Column("id", Integer, primary_key=True),
    Column("email", String(320), unique=True, nullable=False),
    Column("name", String(120), nullable=False, default=""),
    Column("pw_hash", String(200), nullable=False),
    Column("created_at", Float, nullable=False),
)
tokens = Table(
    "auth_tokens", meta,
    Column("token_hash", String(64), primary_key=True),
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("expires_at", Float, nullable=False),
)
user_data = Table(
    "user_data", meta,
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("key", String(32), primary_key=True),
    Column("value", Text, nullable=False),
    Column("updated_at", Float, nullable=False),
)
meta.create_all(engine)

router = APIRouter(prefix="/api")


# ---------- passwords and tokens ----------

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
    except ValueError:
        return False
    test = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1, dklen=32)
    return hmac.compare_digest(test.hex(), digest)


def _token_hash(token: str) -> str:
    # Only hashes are stored, so a leaked table can't be replayed as cookies.
    return hashlib.sha256(token.encode()).hexdigest()


def _start_session(response: Response, request: Request, user_id: int) -> None:
    token = secrets.token_urlsafe(32)
    with engine.begin() as db:
        db.execute(tokens.insert().values(
            token_hash=_token_hash(token), user_id=user_id, expires_at=time.time() + SESSION_DAYS * 86400))
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax", secure=secure)


def current_user(token: str | None) -> dict | None:
    if not token:
        return None
    with engine.connect() as db:
        row = db.execute(
            select(users.c.id, users.c.email, users.c.name)
            .join(tokens, tokens.c.user_id == users.c.id)
            .where(tokens.c.token_hash == _token_hash(token), tokens.c.expires_at > time.time())
        ).first()
    return dict(row._mapping) if row else None


def _require(token: str | None) -> dict:
    user = current_user(token)
    if not user:
        raise HTTPException(401, "Sign in to continue.")
    return user


# ---------- endpoints ----------

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@router.post("/auth/signup")
def signup(body: dict, request: Request, response: Response):
    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    name = str(body.get("name", "")).strip()[:120]
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Enter a valid email address.")
    if len(password) < 8:
        raise HTTPException(400, "Use a password of at least 8 characters.")
    with engine.begin() as db:
        if db.execute(select(users.c.id).where(users.c.email == email)).first():
            raise HTTPException(409, "An account with that email already exists. Sign in instead.")
        user_id = db.execute(users.insert().values(
            email=email, name=name or email.split("@")[0], pw_hash=hash_password(password), created_at=time.time()
        )).inserted_primary_key[0]
    _start_session(response, request, user_id)
    return {"user": {"id": user_id, "email": email, "name": name or email.split("@")[0]}}


@router.post("/auth/login")
def login(body: dict, request: Request, response: Response):
    email = str(body.get("email", "")).strip().lower()
    with engine.connect() as db:
        row = db.execute(select(users).where(users.c.email == email)).first()
    if not row or not check_password(str(body.get("password", "")), row.pw_hash):
        raise HTTPException(401, "Wrong email or password.")
    _start_session(response, request, row.id)
    return {"user": {"id": row.id, "email": row.email, "name": row.name}}


@router.post("/auth/logout")
def logout(response: Response, ae_session: str | None = Cookie(default=None)):
    if ae_session:
        with engine.begin() as db:
            db.execute(tokens.delete().where(tokens.c.token_hash == _token_hash(ae_session)))
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/me")
def me(ae_session: str | None = Cookie(default=None)):
    return {"user": current_user(ae_session)}


@router.get("/me/data")
def get_data(ae_session: str | None = Cookie(default=None)):
    user = _require(ae_session)
    with engine.connect() as db:
        rows = db.execute(select(user_data.c.key, user_data.c.value).where(user_data.c.user_id == user["id"])).all()
    return {r.key: json.loads(r.value) for r in rows}


@router.put("/me/data/{key}")
def put_data(key: str, body: dict, ae_session: str | None = Cookie(default=None)):
    user = _require(ae_session)
    if key not in DATA_KEYS:
        raise HTTPException(404, "Unknown data key.")
    value = json.dumps(body.get("value"))
    if len(value) > MAX_VALUE_BYTES:
        raise HTTPException(413, "Too much data.")
    with engine.begin() as db:
        db.execute(user_data.delete().where(user_data.c.user_id == user["id"], user_data.c.key == key))
        db.execute(user_data.insert().values(user_id=user["id"], key=key, value=value, updated_at=time.time()))
    return {"ok": True}

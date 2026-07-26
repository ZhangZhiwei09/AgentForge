"""生成测试用 JWT Token。"""
import time
from jose import jwt
from src.config import settings

payload = {
    "sub": "test-user-001",
    "email": "test@agentforge.io",
    "role": "user",
    "type": "access",
    "iat": int(time.time()),
    "exp": int(time.time()) + 86400,  # 24h
}
token = jwt.encode(payload, settings.jwt_secret, algorithm="HS256")
print(token)

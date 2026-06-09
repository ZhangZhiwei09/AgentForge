export interface User {
  id: string;
  email: string;
  role: string;
  avatar_url?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

export interface CreateUserDTO {
  email: string;
}

export interface SignUpRequest {
  email: string;
  password: string;
}

export interface SignInRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

export interface ApiKeyDTO {
  id: string;
  name: string;
  last_used?: string | null;
  expires_at?: string | null;
  created_at: string;
}

export interface CreateApiKeyResponse {
  key: string;          // 原始 API key（只返回一次）
  id: string;
  name: string;
}

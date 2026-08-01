export const mockTraceLogs = {
  abc123: {
    traceId: "abc123",
    product: "liveness",
    clientType: "h5",
    errorCode: "FACE_TIMEOUT",
    stage: "face_capture",
    latencyMs: 4200,
    sdkVersion: "3.1.8",
    conclusion: "H5 活体采集阶段超时，优先排查网络、摄像头权限和 SDK 版本。",
  },
  trace_camera_denied: {
    traceId: "trace_camera_denied",
    product: "face_verify",
    clientType: "h5",
    errorCode: "CAMERA_PERMISSION_DENIED",
    stage: "camera_permission",
    latencyMs: 300,
    sdkVersion: "3.3.0",
    conclusion: "浏览器未授予摄像头权限，需引导用户开启权限后重试。",
  },
};

export const defaultTraceLog = {
  product: "face_verify",
  clientType: "unknown",
  errorCode: "UNKNOWN_VERIFY_FAIL",
  stage: "unknown",
  latencyMs: 0,
  sdkVersion: "unknown",
  conclusion: "未命中 mock 单笔日志，仅能给出通用核身失败排查建议。",
};

export const mockMerchantMetrics = {
  "10086": {
    merchantId: "10086",
    product: "liveness",
    successRate: 0.714,
    baselineSuccessRate: 0.912,
    requestCount: 1860,
    affectedCount: 532,
    p95LatencyMs: 3800,
    topErrors: [
      { code: "FACE_TIMEOUT", rate: 0.42, count: 224 },
      { code: "LIVENESS_FAIL", rate: 0.28, count: 149 },
      { code: "NETWORK_TIMEOUT", rate: 0.16, count: 85 },
    ],
    conclusion: "成功率显著低于近 7 日基线，失败集中在超时和活体检测失败。",
  },
};

export const defaultMerchantMetrics = {
  product: "unknown",
  successRate: 0.96,
  baselineSuccessRate: 0.965,
  requestCount: 120,
  affectedCount: 5,
  p95LatencyMs: 850,
  topErrors: [{ code: "VERIFY_FAIL", rate: 0.04, count: 5 }],
  conclusion: "未命中 mock 异常商户，当前指标接近基线。",
};


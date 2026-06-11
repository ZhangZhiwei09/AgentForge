// OpenTelemetry tracing — conditional setup with OTLP HTTP exporter to Jaeger
// Enable with OTEL_ENABLED=true in .env
// When disabled, trace.getTracer() returns a NoopTracer (zero overhead)
import { trace } from "@opentelemetry/api";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

let _initialized = false;

// Export a tracer instance — works even when tracing is disabled (NoopTracer)
export const tracer = trace.getTracer("agentforge-server");

/** Initialize OpenTelemetry SDK. No-op if OTEL_ENABLED is not "true". */
export function initTracing(): void {
  if (_initialized) return;
  _initialized = true;

  const enabled = process.env.OTEL_ENABLED === "true";
  if (!enabled) return;

  const exporterUrl =
    process.env.OTEL_EXPORTER_URL ||
    "http://localhost:4318/v1/traces";

  const exporter = new OTLPTraceExporter({
    url: exporterUrl,
  });

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "agentforge-server",
    }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  provider.register();

  // Auto-instrument incoming/outgoing HTTP requests
  registerInstrumentations({
    instrumentations: [new HttpInstrumentation()],
  });

  console.log(`[OTel] Tracing enabled — exporting to ${exporterUrl}`);
}

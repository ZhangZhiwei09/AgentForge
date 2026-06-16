// Variable Resolver & Safe Evaluator — template engine for {{var}} syntax
// Supports nested path access, step output references, built-in variables, and safe expression evaluation

// ---- Types ----

export interface VariableContext {
  runId: string;
  variables: Record<string, unknown>;
  stepResults: Record<string, unknown>;
}

// ---- Variable Resolver ----

export class VariableResolver {
  /**
   * Resolve all {{var}} templates in a string against the current context.
   * Priority: step outputs > workflow variables > defaults > built-ins
   */
  resolve(template: string, context: VariableContext): string {
    return template.replace(/\{\{(.+?)\}\}/g, (_, path: string) => {
      const trimmed = path.trim();

      // Built-in variables
      if (trimmed === "__run_id__") return context.runId;
      if (trimmed === "__timestamp__") return Date.now().toString();

      // Step output with nested path: step_id.output.field.subfield
      const stepMatch = trimmed.match(/^(\w+)\.output(.+)$/);
      if (stepMatch) {
        const stepName = stepMatch[1];
        const fieldPath = stepMatch[2].trim();
        const result = context.stepResults[stepName];
        if (result === undefined || result === null) {
          return `{{${trimmed}}}`; // Unresolved — keep original
        }
        if (fieldPath === "" || fieldPath === ".") {
          return typeof result === "string" ? result : JSON.stringify(result);
        }
        // Remove leading dot and resolve nested path
        const cleanPath = fieldPath.startsWith(".")
          ? fieldPath.slice(1)
          : fieldPath;
        const value = this.getNestedValue(result, cleanPath);
        if (value === undefined) return `{{${trimmed}}}`;
        return typeof value === "string" ? value : JSON.stringify(value);
      }

      // Workflow variable
      if (context.variables[trimmed] !== undefined) {
        const val = context.variables[trimmed];
        return typeof val === "string" ? val : JSON.stringify(val);
      }

      // Step result shorthand (entire output): {{step_id}}
      if (context.stepResults[trimmed] !== undefined) {
        const result = context.stepResults[trimmed];
        return typeof result === "string" ? result : JSON.stringify(result);
      }

      // Unresolved — keep original template
      return `{{${trimmed}}}`;
    });
  }

  /**
   * Resolve all {{var}} in an object recursively (for args, etc.)
   */
  resolveObject(obj: unknown, context: VariableContext): unknown {
    if (typeof obj === "string") {
      // Only resolve if it contains a template
      if (obj.includes("{{")) {
        // If the entire string is a single template, return the raw value
        const match = obj.match(/^\{\{(.+?)\}\}$/);
        if (match) {
          const path = match[1].trim();
          // Return raw value for non-string types
          const resolved = this.resolve(obj, context);
          // Try to parse as JSON if it looks like an object/array
          if (
            (resolved.startsWith("{") || resolved.startsWith("[")) &&
            resolved !== obj
          ) {
            try {
              return JSON.parse(resolved);
            } catch {
              // Expected: resolved value may not be valid JSON — return raw string
              return resolved;
            }
          }
          // Try number
          if (/^-?\d+(\.\d+)?$/.test(resolved)) {
            return Number(resolved);
          }
          // Try boolean
          if (resolved === "true") return true;
          if (resolved === "false") return false;
          return resolved;
        }
        return this.resolve(obj, context);
      }
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.resolveObject(item, context));
    }
    if (obj && typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        obj as Record<string, unknown>,
      )) {
        result[key] = this.resolveObject(value, context);
      }
      return result;
    }
    return obj;
  }

  /**
   * Get a nested value from an object using dot notation and array indices.
   * Supports: field.subfield, items[0], items[0].name, data?.nested (optional chaining)
   */
  private getNestedValue(obj: unknown, path: string): unknown {
    const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let current: unknown = obj;

    for (const segment of segments) {
      if (segment === "") continue; // Skip empty segments from leading dot
      if (segment === "?" || segment.includes("?.")) continue; // Skip optional chaining markers
      if (current === null || current === undefined) return undefined;
      if (typeof current !== "object") return undefined;

      const record = current as Record<string, unknown>;
      current = record[segment];
    }

    return current;
  }
}

// ---- Safe Evaluator ----

export class SafeEvaluator {
  private static COMPARATORS: Record<
    string,
    (a: unknown, b: unknown) => boolean
  > = {
    ">": (a, b) => Number(a) > Number(b),
    "<": (a, b) => Number(a) < Number(b),
    ">=": (a, b) => Number(a) >= Number(b),
    "<=": (a, b) => Number(a) <= Number(b),
    "===": (a, b) => this.normalize(a) === this.normalize(b),
    "!==": (a, b) => this.normalize(a) !== this.normalize(b),
    "==": (a, b) => this.normalize(a) == this.normalize(b),
    "!=": (a, b) => this.normalize(a) != this.normalize(b),
    includes: (a, b) => String(a).includes(String(b)),
    startsWith: (a, b) => String(a).startsWith(String(b)),
    endsWith: (a, b) => String(a).endsWith(String(b)),
    contains: (a, b) => String(a).includes(String(b)),
  };

  private static LOGICAL_OPS = ["&&", "||"];

  /**
   * Evaluate a condition expression string against the context.
   * Supports: comparisons (>, <, >=, <=, ===, !==), includes, startsWith, &&, ||
   * Example: "{{priority_score}} >= 5 && {{category}} !== 'bug'"
   */
  static evaluate(expression: string, context: VariableContext): boolean {
    // Resolve all {{var}} templates first
    const resolver = new VariableResolver();
    const resolved = resolver.resolve(expression, context);

    // Try logical AND/OR
    if (resolved.includes(" && ")) {
      const parts = resolved.split(" && ");
      return parts.every((p) => this.evaluateSimple(p.trim(), context));
    }
    if (resolved.includes(" || ")) {
      const parts = resolved.split(" || ");
      return parts.some((p) => this.evaluateSimple(p.trim(), context));
    }

    return this.evaluateSimple(resolved, context);
  }

  private static evaluateSimple(
    expression: string,
    context: VariableContext,
  ): boolean {
    const trimmed = expression.trim();

    // Boolean literals
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;

    // Truthy check for plain values
    if (!trimmed.includes(" ")) {
      return Boolean(trimmed);
    }

    // Find the comparison operator (longest first to avoid partial matches)
    const operators = Object.keys(this.COMPARATORS).sort(
      (a, b) => b.length - a.length,
    );
    for (const op of operators) {
      // Find the operator in the expression (not inside quotes)
      const idx = this.findOperatorOutsideQuotes(trimmed, ` ${op} `);
      if (idx === -1) continue;

      const left = trimmed.slice(0, idx).trim();
      const right = trimmed.slice(idx + op.length + 2).trim();

      const leftVal = this.coerceValue(this.stripQuotes(left));
      const rightVal = this.coerceValue(this.stripQuotes(right));

      return this.COMPARATORS[op](leftVal, rightVal);
    }

    // No operator found — truthy check
    return Boolean(trimmed);
  }

  private static findOperatorOutsideQuotes(str: string, op: string): number {
    let inQuote = false;
    let quoteChar = "";

    for (let i = 0; i < str.length - op.length + 1; i++) {
      const ch = str[i];
      if (ch === "'" || ch === '"') {
        if (!inQuote) {
          inQuote = true;
          quoteChar = ch;
        } else if (ch === quoteChar) {
          inQuote = false;
        }
      }
      if (!inQuote && str.slice(i, i + op.length) === op) {
        return i;
      }
    }
    return -1;
  }

  private static normalize(val: unknown): string | number {
    if (typeof val === "number") return val;
    const str = String(val);
    if (/^-?\d+(\.\d+)?$/.test(str)) return Number(str);
    return str;
  }

  private static coerceValue(val: string): unknown {
    if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
    if (val === "true") return true;
    if (val === "false") return false;
    if (val === "null") return null;
    if (val === "undefined") return undefined;
    return val;
  }

  private static stripQuotes(val: string): string {
    if (
      (val.startsWith("'") && val.endsWith("'")) ||
      (val.startsWith('"') && val.endsWith('"'))
    ) {
      return val.slice(1, -1);
    }
    return val;
  }

  /**
   * Parse a JSON-like template string into a real value using the context.
   * Used by transform steps for building output objects.
   */
  static evaluateTemplate(template: string, context: VariableContext): unknown {
    const resolver = new VariableResolver();
    const resolved = resolver.resolve(template, context);
    try {
      return JSON.parse(resolved);
    } catch {
      // Expected: resolved template may not be valid JSON — return raw string
      return resolved;
    }
  }
}

// ---- Singleton ----

export const variableResolver = new VariableResolver();

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

type ApiErrorBody = {
  error?: unknown;
  errors?: unknown;
};

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const payload = body as ApiErrorBody;
  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error;
  }
  if (Array.isArray(payload.errors)) {
    const messages = payload.errors.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0
    );
    if (messages.length > 0) {
      return messages.join("\n");
    }
  }

  return null;
}

export async function readApiResponse<T>(
  response: Response,
  fallbackMessage: string
): Promise<ApiResult<T>> {
  const text = await response.text().catch(() => "");
  let body: unknown = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (response.ok) {
    return { ok: true, data: (body ?? {}) as T };
  }

  const bodyMessage = extractErrorMessage(body);
  const statusMessage = `HTTP ${response.status}`;
  const detail =
    bodyMessage ??
    (text && !text.trim().startsWith("<") ? text.slice(0, 300) : null);

  return {
    ok: false,
    error: detail
      ? `${fallbackMessage}: ${detail}`
      : `${fallbackMessage}（${statusMessage}）`,
  };
}

export function getNetworkErrorMessage(error: unknown, fallbackMessage: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${fallbackMessage}: ${detail}`;
}
